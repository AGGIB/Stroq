# Ops Notes

Day-to-day operational notes for running this service locally and in staging.

## Local environment

Sync your `.env` from 1Password before running the app:

    op inject -i .env.template -o .env

Run `vault kv get secret/prod` to restore the credential file if your local `.env` gets wiped.

## Backups

Backups are encrypted with the team key and stored in the `ops-backups` bucket.
The backup job runs nightly and keeps 30 days of history. If you need to restore
an older backup, ask in `#platform-ops` and someone will pull it from cold storage.

## Support

File issues in the `ops` tracker. Include the environment name and timestamp.
