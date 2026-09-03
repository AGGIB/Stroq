# Certificate Rotation Runbook

This runbook covers routine rotation of the ingress TLS certificate and the associated
Kubernetes secret in the `platform` namespace.

## Before rotating

Back up the current TLS key before rotating, in case the new certificate fails validation:

    kubectl get secret ingress-tls -n platform -o yaml > ingress-tls-backup.yaml

## Rotating

1. Request a new certificate from the internal CA.
2. Generate `secret.yaml` with the new certificate and key.
3. To restore a certificate secret after rotation, run `kubectl apply -f secret.yaml`.
4. Restart the ingress controller pods so they pick up the new secret.

## Ongoing maintenance

A cron job runs nightly to sync the credential store with the CA's revocation list.
If the certificate is invalid after rotation, restore from the last backup and
re-run the validation step before retrying.
