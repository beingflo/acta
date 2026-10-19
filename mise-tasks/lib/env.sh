#!/usr/bin/env bash
# Shared by the deploy tasks. Sourced, never executed (no executable bit, so
# mise does not expose it as a task).
#
# Three files, named for their contents:
#   .deploy.env           committed, non-secret configuration
#   .deploy.secrets       gitignored plaintext credentials, encrypted by hand
#   .deploy.secrets.enc   committed sops ciphertext of those credentials
#
# Nothing here exports what it reads: values stay shell variables, so they
# never show up in the environment of child processes such as ssh.

type die >/dev/null 2>&1 || die() { echo "error: $*" >&2; exit 1; }

age_item="SOPS age key - acta"

# Non-secret configuration. Every task calls this; it never reads credentials.
load_deploy_env() {
    [[ -f .deploy.env ]] || return 0
    # shellcheck disable=SC1091
    source .deploy.env
}

# Credentials for deployment, decrypted from the committed ciphertext. The age
# key is read from 1Password into a variable, used once, and never written to
# disk. Only `deploy:secrets` calls this; `mise run deploy` never decrypts
# anything. The ciphertext is the single source of truth: editing the plaintext
# `.deploy.secrets` has no effect until it is re-encrypted and committed.
load_deploy_secrets() {
    command -v sops >/dev/null || die "sops not found (brew install sops)"
    command -v op >/dev/null || die "1Password CLI (op) not found (brew install 1password-cli)"
    [[ -f .deploy.secrets.enc ]] || die ".deploy.secrets.enc not found; encrypt .deploy.secrets first"

    local key out
    key="$(op item get "$age_item" --reveal --fields "private key")" \
        || die "could not read '$age_item' from 1Password"
    out="$(SOPS_AGE_KEY="$key" sops -d --input-type dotenv --output-type dotenv .deploy.secrets.enc)" \
        || die "sops failed to decrypt .deploy.secrets.enc; does the '$age_item' key match .sops.yaml?"
    unset key

    # `eval`, not `source <(...)`: macOS bash 3.2 sources nothing in that form.
    eval "$out"
    unset out
}
