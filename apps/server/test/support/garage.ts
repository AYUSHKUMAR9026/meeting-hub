/**
 * A real Garage (the S3-compatible server used in local dev) for integration tests, bootstrapped
 * like infra/garage/init.sh: node layout, a fixed access key, a bucket with CORS and a lifecycle rule.
 */
import {
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const GARAGE_IMAGE = 'dxflrs/garage:v2.4.1';

const ADMIN_TOKEN = 'test-admin-token';
// Test-only credentials for a throwaway container.
export const GARAGE_ACCESS_KEY_ID = 'GK00000000000000000000aaaa';
export const GARAGE_SECRET_ACCESS_KEY = 'a'.repeat(64);
export const GARAGE_REGION = 'garage';
export const GARAGE_BUCKET = 'meeting-hub-test';
export const TEST_WEB_ORIGIN = 'http://localhost:3000';

const GARAGE_TOML = `
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
s3_region = "${GARAGE_REGION}"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
`;

export interface StartedGarage {
  container: StartedTestContainer;
  endpoint: string;
}

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 60): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${label} did not succeed: ${String(lastError)}`);
}

export async function startGarage(): Promise<StartedGarage> {
  const container = await new GenericContainer(GARAGE_IMAGE)
    .withEnvironment({
      GARAGE_RPC_SECRET: 'b'.repeat(64),
      GARAGE_ADMIN_TOKEN: ADMIN_TOKEN,
    })
    .withCopyContentToContainer([{ content: GARAGE_TOML, target: '/etc/garage.toml' }])
    .withExposedPorts(3900, 3903)
    // Any HTTP answer from the admin API means Garage is up (/health is 503 until a layout exists).
    .withWaitStrategy(Wait.forHttp('/health', 3903).forStatusCodeMatching(() => true))
    .start();

  const admin = `http://${container.getHost()}:${container.getMappedPort(3903)}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${admin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  const status = await retry('GetClusterStatus', () => api('GET', '/v2/GetClusterStatus'));
  const nodeId = (status.nodes as { id: string }[])[0]!.id;
  const layout = await api('GET', '/v2/GetClusterLayout');
  await api('POST', '/v2/UpdateClusterLayout', {
    roles: [{ id: nodeId, zone: 'dc1', capacity: 1_000_000_000, tags: [] }],
  });
  await api('POST', '/v2/ApplyClusterLayout', { version: (layout.version as number) + 1 });
  await api('POST', '/v2/ImportKey', {
    accessKeyId: GARAGE_ACCESS_KEY_ID,
    secretAccessKey: GARAGE_SECRET_ACCESS_KEY,
    name: 'test',
  });
  const bucket = await retry('CreateBucket', () =>
    api('POST', '/v2/CreateBucket', { globalAlias: GARAGE_BUCKET }),
  );
  await api('POST', '/v2/AllowBucketKey', {
    bucketId: bucket.id,
    accessKeyId: GARAGE_ACCESS_KEY_ID,
    permissions: { read: true, write: true, owner: true },
  });

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(3900)}`;
  const s3 = new S3Client({
    region: GARAGE_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: GARAGE_ACCESS_KEY_ID, secretAccessKey: GARAGE_SECRET_ACCESS_KEY },
  });
  try {
    await retry('PutBucketCors', () =>
      s3.send(
        new PutBucketCorsCommand({
          Bucket: GARAGE_BUCKET,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [TEST_WEB_ORIGIN],
                AllowedMethods: ['PUT', 'GET', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      ),
    );
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: GARAGE_BUCKET,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart-uploads',
              Status: 'Enabled',
              Filter: {},
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        },
      }),
    );
  } finally {
    s3.destroy();
  }
  return { container, endpoint };
}
