#!/usr/bin/env bash
# ====================================================================
# Deployment Script for SchoolIMS Production Database Backup Subsystem
# Isolated from simsapi.nexsyrus.com / supabasebackend Cloud Run service.
# ====================================================================
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${GCP_REGION:-asia-south1}"
BUCKET_NAME="${GCS_BACKUP_BUCKET:-schoolims-db-backups-${PROJECT_ID}}"
JOB_NAME="${BACKUP_CLOUD_RUN_JOB:-schoolims-db-backup}"
WORKER_SA="schoolims-backup-worker"
SCHEDULER_SA="schoolims-backup-scheduler"
CONSOLE_SA="schoolims-backup-console"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${JOB_NAME}:latest"

WORKER_EMAIL="${WORKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_EMAIL="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
CONSOLE_EMAIL="${CONSOLE_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=========================================================="
echo "Deploying SchoolIMS Backup Subsystem"
echo "Project:   ${PROJECT_ID}"
echo "Region:    ${REGION}"
echo "Bucket:    gs://${BUCKET_NAME}"
echo "Image:     ${IMAGE_NAME}"
echo "=========================================================="

echo "--> Enabling required APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    storage.googleapis.com \
    secretmanager.googleapis.com \
    cloudkms.googleapis.com \
    --project="${PROJECT_ID}"

ensure_sa() {
    local name="$1"
    local display="$2"
    if ! gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" --project="${PROJECT_ID}" >/dev/null 2>&1; then
        gcloud iam service-accounts create "${name}" \
            --display-name="${display}" \
            --project="${PROJECT_ID}"
    fi
}

echo "--> Provisioning dedicated service accounts..."
ensure_sa "${WORKER_SA}" "SchoolIMS Database Backup Worker"
ensure_sa "${SCHEDULER_SA}" "SchoolIMS Database Backup Scheduler"
ensure_sa "${CONSOLE_SA}" "SchoolIMS Founder Console Backup Trigger"

echo "--> Creating & securing private backup storage bucket..."
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://${BUCKET_NAME}" \
        --project="${PROJECT_ID}" \
        --location="${REGION}" \
        --uniform-bucket-level-access \
        --public-access-prevention
else
    gcloud storage buckets update "gs://${BUCKET_NAME}" \
        --uniform-bucket-level-access \
        --public-access-prevention
fi

# 30-day soft-delete window so accidental object deletes remain recoverable.
gcloud storage buckets update "gs://${BUCKET_NAME}" \
    --soft-delete-duration=2592000s \
    --project="${PROJECT_ID}" || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gcloud storage buckets update "gs://${BUCKET_NAME}" \
    --lifecycle-file="${SCRIPT_DIR}/gcs_lifecycle.json"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
    --member="serviceAccount:${WORKER_EMAIL}" \
    --role="roles/storage.objectAdmin"

echo "--> Verifying Secret Manager secrets..."
if ! gcloud secrets describe "BACKUP_ENCRYPTION_KEY" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "Creating new BACKUP_ENCRYPTION_KEY secret..."
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "BACKUP_ENCRYPTION_KEY" \
        --data-file=- \
        --replication-policy="automatic" \
        --project="${PROJECT_ID}"
fi

if ! gcloud secrets describe "DATABASE_URL_DIRECT" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "ERROR: Secret DATABASE_URL_DIRECT does not exist. Create it before deploying the backup job."
    echo "  printf '%s' 'YOUR_DIRECT_POSTGRES_URL' | gcloud secrets create DATABASE_URL_DIRECT --data-file=- --replication-policy=automatic --project=${PROJECT_ID}"
    exit 1
fi

gcloud secrets add-iam-policy-binding "BACKUP_ENCRYPTION_KEY" \
    --member="serviceAccount:${WORKER_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="${PROJECT_ID}"

if gcloud secrets describe "DATABASE_URL_DIRECT" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud secrets add-iam-policy-binding "DATABASE_URL_DIRECT" \
        --member="serviceAccount:${WORKER_EMAIL}" \
        --role="roles/secretmanager.secretAccessor" \
        --project="${PROJECT_ID}"
fi

echo "--> Building & pushing container image via Cloud Build..."
gcloud builds submit "${SCRIPT_DIR}/.." \
    --tag="${IMAGE_NAME}" \
    --project="${PROJECT_ID}"

echo "--> Deploying Cloud Run Job: ${JOB_NAME}..."
gcloud run jobs deploy "${JOB_NAME}" \
    --image="${IMAGE_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --service-account="${WORKER_EMAIL}" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=1 \
    --task-timeout=3600s \
    --cpu=2 \
    --memory=4Gi \
    --set-env-vars="NODE_ENV=production,GCS_BACKUP_BUCKET=${BUCKET_NAME},GCP_PROJECT_ID=${PROJECT_ID},ANOMALY_THRESHOLD_PERCENT=25,STALE_BACKUP_HOURS=26,BACKUP_TYPE=daily" \
    --set-secrets="DATABASE_URL_DIRECT=DATABASE_URL_DIRECT:latest,BACKUP_ENCRYPTION_KEY=BACKUP_ENCRYPTION_KEY:latest"

echo "--> Configuring IAM permissions for Scheduler and Founder Console..."
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --member="serviceAccount:${SCHEDULER_EMAIL}" \
    --role="roles/run.invoker"

gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --member="serviceAccount:${CONSOLE_EMAIL}" \
    --role="roles/run.invoker"

upsert_scheduler() {
    local name="$1"
    local schedule="$2"
    local backup_type="$3"
    local uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"
    local body
    body="$(printf '{"overrides":{"containerOverrides":[{"env":[{"name":"BACKUP_TYPE","value":"%s"}]}]}}' "${backup_type}")"

    local common_args=(
        --location="${REGION}"
        --project="${PROJECT_ID}"
        --schedule="${schedule}"
        --time-zone="Asia/Kolkata"
        --uri="${uri}"
        --http-method="POST"
        --headers="Content-Type=application/json"
        --message-body="${body}"
        --oauth-service-account-email="${SCHEDULER_EMAIL}"
        --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
    )

    if gcloud scheduler jobs describe "${name}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
        gcloud scheduler jobs update http "${name}" "${common_args[@]}"
    else
        gcloud scheduler jobs create http "${name}" "${common_args[@]}"
    fi
}

echo "--> Configuring Cloud Scheduler triggers..."
upsert_scheduler "schoolims-daily-db-backup" "0 2 * * *" "daily"
upsert_scheduler "schoolims-weekly-db-backup" "0 3 * * 0" "weekly"
upsert_scheduler "schoolims-monthly-db-backup" "0 4 1 * *" "monthly"

echo "=========================================================="
echo "Deployment complete!"
echo "Cloud Run Job:          ${JOB_NAME} (private, IAM-invoked only)"
echo "Daily scheduler:        schoolims-daily-db-backup   (02:00 Asia/Kolkata)"
echo "Weekly scheduler:       schoolims-weekly-db-backup  (Sunday 03:00 Asia/Kolkata)"
echo "Monthly scheduler:      schoolims-monthly-db-backup (1st 04:00 Asia/Kolkata)"
echo "Bucket:                 gs://${BUCKET_NAME}"
echo "Worker SA:              ${WORKER_EMAIL}"
echo "Scheduler SA:           ${SCHEDULER_EMAIL}"
echo "Founder Console SA:     ${CONSOLE_EMAIL}"
echo
echo "Create a JSON key for ${CONSOLE_EMAIL} and store it as BACKUP_TRIGGER_SA_JSON"
echo "on the Founder Console backend. Never commit that key."
echo "=========================================================="
