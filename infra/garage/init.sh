#!/bin/sh
# One-shot, idempotent bootstrap of a single-node Garage cluster for local dev:
#   1. assign a layout to the node, 2. import a fixed dev access key,
#   3. create the dev bucket and grant the key access to it,
#   4. set bucket CORS (browser uploads) and a lifecycle rule for abandoned multipart uploads.
# Uses Garage's v2 admin HTTP API and curl's SigV4 signing, so it runs from a plain curl image.
set -eu

ADMIN="${GARAGE_ADMIN_URL:-http://garage:3903}"
AUTH="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"

api() { # api METHOD PATH [JSON_BODY]
  if [ $# -ge 3 ]; then
    curl -sS -f -X "$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$3" "$ADMIN$2"
  else
    curl -sS -f -X "$1" -H "$AUTH" "$ADMIN$2"
  fi
}
compact() { tr -d ' \n\r\t'; }

echo "garage-init: waiting for admin API..."
i=0
until api GET /v2/GetClusterStatus >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "garage-init: admin API not reachable"; exit 1; }
  sleep 1
done

NODE_ID=$(api GET /v2/GetClusterStatus | compact | sed -n 's/.*"nodes":\[{"id":"\([0-9a-f]*\)".*/\1/p')
[ -n "$NODE_ID" ] || { echo "garage-init: could not determine node id"; exit 1; }

LAYOUT=$(api GET /v2/GetClusterLayout | compact)
if echo "$LAYOUT" | grep -q '"roles":\[\]'; then
  VERSION=$(echo "$LAYOUT" | sed -n 's/^{"version":\([0-9]*\).*/\1/p')
  echo "garage-init: assigning layout to node ${NODE_ID} (layout v$((VERSION + 1)))"
  api POST /v2/UpdateClusterLayout "{\"roles\":[{\"id\":\"${NODE_ID}\",\"zone\":\"dc1\",\"capacity\":10000000000,\"tags\":[\"dev\"]}]}" >/dev/null
  api POST /v2/ApplyClusterLayout "{\"version\":$((VERSION + 1))}" >/dev/null
else
  echo "garage-init: layout already assigned"
fi

if api GET "/v2/GetKeyInfo?id=${S3_ACCESS_KEY_ID}" >/dev/null 2>&1; then
  echo "garage-init: access key already present"
else
  echo "garage-init: importing dev access key"
  api POST /v2/ImportKey "{\"accessKeyId\":\"${S3_ACCESS_KEY_ID}\",\"secretAccessKey\":\"${S3_SECRET_ACCESS_KEY}\",\"name\":\"meeting-hub-dev\"}" >/dev/null
fi

if api GET "/v2/GetBucketInfo?globalAlias=${S3_BUCKET}" >/dev/null 2>&1; then
  echo "garage-init: bucket ${S3_BUCKET} already exists"
else
  echo "garage-init: creating bucket ${S3_BUCKET}"
  api POST /v2/CreateBucket "{\"globalAlias\":\"${S3_BUCKET}\"}" >/dev/null
fi

BUCKET_ID=$(api GET "/v2/GetBucketInfo?globalAlias=${S3_BUCKET}" | compact | sed -n 's/^{"id":"\([0-9a-f]*\)".*/\1/p')
[ -n "$BUCKET_ID" ] || { echo "garage-init: could not determine bucket id"; exit 1; }
api POST /v2/AllowBucketKey "{\"bucketId\":\"${BUCKET_ID}\",\"accessKeyId\":\"${S3_ACCESS_KEY_ID}\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null

# Bucket settings go through the S3 API (SigV4-signed by curl), not the admin API.
S3_URL="${S3_API_URL:-http://garage:3900}/${S3_BUCKET}"
s3_put() { # s3_put SUBRESOURCE XML_BODY
  curl -sS -f --aws-sigv4 "aws:amz:garage:s3" --user "${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}" \
    -X PUT -H 'Content-Type: application/xml' --data-binary "$2" "${S3_URL}?$1" >/dev/null
}

# Browsers upload recordings straight to the bucket (ADR 0003): allow the web origin and EXPOSE
# ETag, without which the browser can't read part ETags and multipart uploads can't complete.
ORIGINS=""
for origin in $(echo "${CORS_ALLOWED_ORIGINS:-http://localhost:3000}" | tr ',' ' '); do
  ORIGINS="${ORIGINS}<AllowedOrigin>${origin}</AllowedOrigin>"
done
echo "garage-init: setting bucket CORS for ${CORS_ALLOWED_ORIGINS:-http://localhost:3000}"
s3_put cors "<CORSConfiguration><CORSRule>${ORIGINS}<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>"

# Backstop for abandoned uploads; the media.abort-stale-uploads job is the guarantee.
echo "garage-init: aborting incomplete multipart uploads after 1 day"
s3_put lifecycle "<LifecycleConfiguration><Rule><ID>abort-incomplete-multipart-uploads</ID><Status>Enabled</Status><Filter></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>"

echo "garage-init: done (bucket=${S3_BUCKET})"
