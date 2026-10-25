//! The epaper panel in the living room: `embedded-v2/dashboard` asks for one
//! bitmap every couple of minutes and puts it on a 792×272 one-bit display.
//!
//! The device has no clock, no fonts and no chart library, and pulling a
//! rendered picture is far cheaper for it than drawing one. So the whole image
//! is made here: the CO2 curve of the last six hours on the left, four scalar
//! readings in a column on the right. The response body is the panel's native
//! format — one bit per pixel, MSB first, 99 bytes per row — because that is
//! exactly what the sketch copies into its paint buffer.
//!
//! Everything on the panel is a **home** reading: the four names come out of the
//! metric registry with `Scope::Home`, so the device can be given the restricted
//! credential and see nothing the web dashboard would not show a restricted
//! viewer. `GET /api/dashboard.png` renders the same image as a PNG, for
//! checking a layout change without standing in front of the panel.

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration, Utc};
use plotters::prelude::*;
use plotters::style::text_anchor::{HPos, Pos, VPos};
use serde_json::Value;

use crate::api::{ApiError, AppState};
use crate::auth::Scope;
use crate::metrics;

/// The drawing surface, not the 800-pixel frame the controller shifts out: the
/// panel's visible width is 792 px and the remaining 8 are left blank.
const WIDTH: u32 = 792;
const HEIGHT: u32 = 272;
/// `ceil(WIDTH / 8)`, the stride of the one-bit buffer.
const ROW_BYTES: usize = (WIDTH as usize).div_ceil(8);

/// Text and lines are drawn at twice the panel's resolution and averaged back
/// down. Plotters' only typeface is antialiased, and a one-bit panel turns plain
/// anti-aliasing into broken glyphs; over-rendering and averaging keeps the
/// labels legible and the curve continuous.
const SCALE: u32 = 2;

/// The large graph: living-room CO2, six hours, one minute per point. Six hours
/// at a minute per point is 360 points across ~600 px, which is still dense
/// enough to read as a curve rather than a staircase.
const GRAPH_METRIC: &str = "co2_ppm";
const GRAPH_HOURS: i64 = 6;
const GRAPH_BUCKET_MS: u64 = 60_000;
/// The y axis is padded instead of fixed: an unremarkable day sits in a narrow
/// band and should fill the height, while a stuffy afternoon is still on screen.
const GRAPH_PAD_PPM: f64 = 50.0;

/// The panel's x labels are wall-clock times of the house the display hangs in.
/// The service itself runs in UTC.
const ZONE: &str = "Europe/Zurich";

/// The three scalar readings beside the graph. The fourth cell, CO2, is the last
/// point of the graph itself, so the number always matches the curve's right end.
const TEMPERATURE_METRIC: &str = "living_temp_c";
const LAUNDRY_HUMIDITY_METRIC: &str = "laundry_humidity_pct";
const LIVING_HUMIDITY_METRIC: &str = "living_humidity_pct";

/// A temperature is taken from the last minute, so a single odd sample does not
/// move it; the humidities are averaged over the hour, like the web dashboard's
/// tiles.
const TEMPERATURE_WINDOW_MINUTES: i64 = 15;
const HUMIDITY_WINDOW_MINUTES: i64 = 60;
/// One bucket per minute for the scalar series: fine enough that "the last
/// point" is the latest reading, coarse enough that an hour is 60 numbers.
const SCALAR_BUCKET_MS: u64 = 60_000;

/// The bitmap, as the panel wants it.
pub async fn bitmap(State(state): State<AppState>) -> Response {
    match frame(&state).await {
        Ok(rgb) => picture(
            to_bitmap(&rgb),
            "application/octet-stream",
            state.dashboard_refresh_seconds,
        ),
        Err(err) => err.into_response(),
    }
}

/// The same picture as a PNG: a browser or `curl` can show it, the device cannot
/// decode it.
pub async fn preview(State(state): State<AppState>) -> Response {
    match frame(&state).await {
        Ok(rgb) => match to_png(&rgb) {
            Ok(png) => picture(png, "image/png", state.dashboard_refresh_seconds),
            Err(message) => ApiError::Internal(message).into_response(),
        },
        Err(err) => err.into_response(),
    }
}

/// The header tells the device when to come back, so the refresh interval can be
/// changed without opening the panel and reflashing it.
fn picture(body: Vec<u8>, content_type: &'static str, refresh_seconds: u64) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(value) = refresh_seconds.to_string().parse() {
        headers.insert("X-Refresh-Seconds", value);
    }
    (StatusCode::OK, headers, body).into_response()
}

/// One point of a series: the bucket's start as an epoch second, and its value.
#[derive(Clone, Copy)]
struct Point {
    at: f64,
    value: f64,
}

/// Read the readings the panel shows and draw them.
async fn frame(state: &AppState) -> Result<Vec<u8>, ApiError> {
    let now = Utc::now();

    // One read guard for all four queries: a compaction swap must not land
    // between the curve and the scalar that is supposed to sit at its end.
    let _read = state.data_lock.read().await;

    let curve = series(
        state,
        GRAPH_METRIC,
        now - Duration::hours(GRAPH_HOURS),
        now,
        GRAPH_BUCKET_MS,
    )
    .await?;
    if curve.len() < 2 {
        return Err(ApiError::Unavailable(format!(
            "no {GRAPH_METRIC} readings in the last {GRAPH_HOURS} hours"
        )));
    }

    let temperature = latest(
        &series(
            state,
            TEMPERATURE_METRIC,
            now - Duration::minutes(TEMPERATURE_WINDOW_MINUTES),
            now,
            SCALAR_BUCKET_MS,
        )
        .await?,
    );

    let laundry_humidity = mean(
        &series(
            state,
            LAUNDRY_HUMIDITY_METRIC,
            now - Duration::minutes(HUMIDITY_WINDOW_MINUTES),
            now,
            SCALAR_BUCKET_MS,
        )
        .await?,
    );

    let living_humidity = mean(
        &series(
            state,
            LIVING_HUMIDITY_METRIC,
            now - Duration::minutes(HUMIDITY_WINDOW_MINUTES),
            now,
            SCALAR_BUCKET_MS,
        )
        .await?,
    );

    let panel = [
        ("Temperature", temperature, "C"),
        ("CO2", latest(&curve), "ppm"),
        ("Hum. Laundry", laundry_humidity, "%"),
        ("Hum. Living", living_humidity, "%"),
    ];

    render(&curve, &panel)
}

/// The newest reading of a series.
fn latest(points: &[Point]) -> Option<f64> {
    points.last().map(|point| point.value)
}

/// The average over the series' buckets, which is the average over its window
/// as long as the buckets are equally wide and equally full — true enough at
/// this resolution, and one query instead of a second aggregate.
fn mean(points: &[Point]) -> Option<f64> {
    if points.is_empty() {
        return None;
    }
    let sum: f64 = points.iter().map(|point| point.value).sum();
    Some(sum / points.len() as f64)
}

/// One named reading over `[from, to)`, bucketed.
///
/// The metric is looked up for a *restricted* viewer on purpose: the panel is a
/// home dashboard, so anything it shows has to be something that credential may
/// read. A metric someone marks as owner-only therefore breaks the build of the
/// picture loudly instead of leaking out of the display.
async fn series(
    state: &AppState,
    id: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket_ms: u64,
) -> Result<Vec<Point>, ApiError> {
    let metric = metrics::lookup(id, Scope::Home).map_err(|message| {
        tracing::error!(%message, "the display names a metric a restricted viewer may not read");
        ApiError::Internal(message)
    })?;
    let json = state
        .db
        .query_json(metrics::series_sql(metric, from, to, bucket_ms))
        .await?;
    parse_series(&json, id)
}

/// The series endpoint's `[{ t, s0 }]` shape. Buckets with no value (a gap in
/// the feed) come back as `null` and are dropped: a gap should break the line,
/// not draw a spike to zero.
fn parse_series(json: &str, id: &str) -> Result<Vec<Point>, ApiError> {
    let rows: Vec<Value> = serde_json::from_str(json)
        .map_err(|e| ApiError::Internal(format!("series {id} is not JSON: {e}")))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let at = row.get("t")?;
            let at = at.as_f64().or_else(|| at.as_i64().map(|v| v as f64))?;
            let value = row.get("s0")?.as_f64()?;
            Some(Point { at, value })
        })
        .collect())
}

/// Draw the panel at `WIDTH`×`HEIGHT`, returning RGB so the bitmap and the PNG
/// preview share one renderer.
fn render(curve: &[Point], panel: &[(&str, Option<f64>, &str); 4]) -> Result<Vec<u8>, ApiError> {
    if curve.len() < 2 {
        return Err(ApiError::Internal("a chart needs two points".into()));
    }
    render_chart(curve, panel).map_err(|e| ApiError::Internal(format!("chart: {e}")))
}

fn render_chart(
    curve: &[Point],
    panel: &[(&str, Option<f64>, &str); 4],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let width = WIDTH * SCALE;
    let height = HEIGHT * SCALE;
    let mut hi = vec![0u8; (width * height * 3) as usize];

    let zone = jiff::tz::TimeZone::get(ZONE)?;

    {
        let root = BitMapBackend::with_buffer(&mut hi, (width, height)).into_drawing_area();
        root.fill(&WHITE)?;

        let (chart_area, info_area) = root.split_horizontally((width * 4 / 5) as i32);

        let values = curve.iter().map(|point| point.value);
        let y_min = values.clone().fold(f64::INFINITY, f64::min) - GRAPH_PAD_PPM;
        let y_max = values.fold(f64::NEG_INFINITY, f64::max) + GRAPH_PAD_PPM;

        let mut chart = ChartBuilder::on(&chart_area)
            .margin(10 * SCALE as i32)
            .x_label_area_size(24 * SCALE)
            .y_label_area_size(48 * SCALE)
            .build_cartesian_2d(0.0f64..(curve.len() - 1) as f64, y_min..y_max)?;

        // Index to wall-clock label. The x range is the point index rather than
        // the timestamp, so a gap in the feed does not open a hole in the curve;
        // the label is what carries the time.
        let labels: Vec<String> = curve
            .iter()
            .map(|point| {
                jiff::Timestamp::from_second(point.at as i64)
                    .ok()
                    .map(|at| at.to_zoned(zone.clone()))
                    .map(|at| format!("{:02}:{:02}", at.hour(), at.minute()))
                    .unwrap_or_default()
            })
            .collect();

        chart
            .configure_mesh()
            .disable_x_mesh()
            .disable_y_mesh()
            .x_labels(10)
            .x_label_formatter(&|x| labels.get(*x as usize).cloned().unwrap_or_default())
            .x_label_style(text(16.0))
            .y_label_style(text(16.0))
            .draw()?;

        chart.draw_series(LineSeries::new(
            curve
                .iter()
                .enumerate()
                .map(|(i, point)| (i as f64, point.value)),
            ShapeStyle::from(&BLACK).stroke_width(2 * SCALE),
        ))?;

        let (chart_w, _) = chart_area.dim_in_pixel();
        chart_area.draw_text(
            "CO2 Living Room [ppm]",
            &text(14.0).pos(Pos::new(HPos::Right, VPos::Top)),
            (chart_w as i32 - 12 * SCALE as i32, 12 * SCALE as i32),
        )?;

        // The side panel: one cell per scalar, hairline separators between them.
        let (info_w, info_h) = info_area.dim_in_pixel();
        let (info_w, info_h) = (info_w as i32, info_h as i32);
        let cell_h = info_h / 4;
        let separator = ShapeStyle::from(&BLACK).stroke_width(SCALE);

        info_area.draw(&PathElement::new(vec![(0, 0), (0, info_h)], separator))?;
        for row in 1..4 {
            info_area.draw(&PathElement::new(
                vec![(0, cell_h * row), (info_w, cell_h * row)],
                separator,
            ))?;
        }

        for (i, (label, value, unit)) in panel.iter().enumerate() {
            let top = cell_h * i as i32;
            let center = info_w / 2;
            info_area.draw_text(
                label,
                &text(16.0).pos(Pos::new(HPos::Center, VPos::Top)),
                (center, top + 8 * SCALE as i32),
            )?;
            let value = match value {
                Some(value) => format!("{value:.1} {unit}"),
                None => "--".to_string(),
            };
            info_area.draw_text(
                &value,
                &text(24.0).pos(Pos::new(HPos::Center, VPos::Center)),
                (center, top + cell_h / 2 + 8 * SCALE as i32),
            )?;
        }

        root.present()?;
    }

    Ok(downscale(&hi, width))
}

/// Bold sans-serif at `size`, in the panel's own units: the caller's size is at
/// panel resolution, and over-rendering multiplies it.
fn text(size: f64) -> TextStyle<'static> {
    FontDesc::new(FontFamily::SansSerif, size * SCALE as f64, FontStyle::Bold).color(&BLACK)
}

/// Average each `SCALE`×`SCALE` block back down to one pixel.
fn downscale(hi: &[u8], hi_width: u32) -> Vec<u8> {
    let mut rgb = vec![0u8; (WIDTH * HEIGHT * 3) as usize];
    for y in 0..HEIGHT as usize {
        for x in 0..WIDTH as usize {
            for channel in 0..3 {
                let mut sum = 0u32;
                for dy in 0..SCALE as usize {
                    for dx in 0..SCALE as usize {
                        let hi_x = x * SCALE as usize + dx;
                        let hi_y = y * SCALE as usize + dy;
                        sum += hi[(hi_y * hi_width as usize + hi_x) * 3 + channel] as u32;
                    }
                }
                rgb[(y * WIDTH as usize + x) * 3 + channel] = (sum / (SCALE * SCALE)) as u8;
            }
        }
    }
    rgb
}

/// One bit per pixel, MSB first, a set bit meaning white — the panel's
/// `EPD_ShowPicture` treats a set bit as "leave the paper alone".
fn to_bitmap(rgb: &[u8]) -> Vec<u8> {
    let mut bitmap = vec![0u8; ROW_BYTES * HEIGHT as usize];
    for y in 0..HEIGHT as usize {
        for x in 0..WIDTH as usize {
            let pixel = (y * WIDTH as usize + x) * 3;
            // One-bit panels have no colour to weigh, so a plain mean is the
            // right threshold: a red pixel and a green one of equal lightness
            // should survive or vanish together.
            let luminance = (rgb[pixel] as u16 + rgb[pixel + 1] as u16 + rgb[pixel + 2] as u16) / 3;
            if luminance >= 128 {
                bitmap[y * ROW_BYTES + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    bitmap
}

fn to_png(rgb: &[u8]) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    image::ImageEncoder::write_image(encoder, rgb, WIDTH, HEIGHT, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("png: {e}"))?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve() -> Vec<Point> {
        (0..360)
            .map(|i| Point {
                at: 1_772_000_000.0 + i as f64 * 60.0,
                value: 800.0 + (i as f64 / 40.0).sin() * 200.0,
            })
            .collect()
    }

    fn panel() -> [(&'static str, Option<f64>, &'static str); 4] {
        [
            ("Temperature", Some(21.4), "C"),
            ("CO2", Some(1234.0), "ppm"),
            ("Hum. Laundry", Some(48.2), "%"),
            ("Hum. Living", None, "%"),
        ]
    }

    #[test]
    fn the_bitmap_is_the_panels_native_frame() {
        let bitmap = to_bitmap(&vec![255u8; (WIDTH * HEIGHT * 3) as usize]);
        assert_eq!(bitmap.len(), ROW_BYTES * HEIGHT as usize);
        assert_eq!(bitmap.len(), 99 * 272);
        assert!(bitmap.iter().all(|byte| *byte == 0xff), "white is a set bit");

        let black = to_bitmap(&vec![0u8; (WIDTH * HEIGHT * 3) as usize]);
        assert!(black.iter().all(|byte| *byte == 0x00), "black is a clear bit");
    }

    #[test]
    fn a_render_fills_the_frame_and_leaves_ink_on_the_panel() {
        let rgb = render(&curve(), &panel()).expect("render");
        assert_eq!(rgb.len(), (WIDTH * HEIGHT * 3) as usize);

        // A chart of a curve is mostly paper with ink on it: if either half is
        // missing, the layout collapsed or the series was not drawn at all.
        let dark = rgb
            .chunks(3)
            .filter(|pixel| pixel.iter().map(|c| *c as u32).sum::<u32>() < 384)
            .count();
        let total = (WIDTH * HEIGHT) as usize;
        assert!(dark > total / 200, "almost nothing was drawn: {dark} px");
        assert!(dark < total / 3, "the panel is mostly ink: {dark} px");
    }

    #[test]
    fn the_png_has_the_panels_dimensions() {
        let rgb = render(&curve(), &panel()).expect("render");
        let png = to_png(&rgb).expect("png");
        let decoded = image::load_from_memory(&png).expect("decode");
        assert_eq!(decoded.width(), WIDTH);
        assert_eq!(decoded.height(), HEIGHT);
    }
}
