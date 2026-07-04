# Bug report — `@aws-blocks/bb-agent`: Agent's S3 snapshot storage hardcodes `us-east-1`, breaking every non-`us-east-1` deployment

> Draft to file against the AWS Blocks issue tracker. Reproduced on a real deploy
> to `ap-northeast-1`.

## Summary

When an `Agent` is deployed to any region **other than `us-east-1`**, the **first
message fails** with:

```
S3 error reading <sessionId>/scopes/agent/agent/snapshots/snapshot_latest.json
```

The agent never reaches the model — it dies while loading its (nonexistent, first-turn)
session snapshot from S3.

## Affected versions

- `@aws-blocks/bb-agent` **0.1.3** and **0.3.0** (identical code path)
- `@strands-agents/sdk` **1.3.0**
- Deployed via `npm run sandbox` / `npm run deploy` to `ap-northeast-1`

## Root cause

`bb-agent`'s AWS Agent constructs Strands' `S3Storage` **without a region or client**:

```js
// @aws-blocks/bb-agent/dist/agent.aws.js
(bucket) => new S3Storage({ bucket: bucket.fullId })
```

Strands' `S3Storage` then **defaults the S3 client region to `us-east-1`**:

```js
// @strands-agents/sdk/dist/src/session/s3-storage.js
this._s3 = config.s3Client ?? new S3Client({ region: config.region ?? 'us-east-1' });
```

The snapshot bucket lives in the deploy region (e.g. `ap-northeast-1`). A `GetObject`
sent to the `us-east-1` endpoint for a bucket in another region returns
**`PermanentRedirect` (301)**. Strands' `_readJSON` only treats `NoSuchKey`/`NoSuchBucket`
as "empty" and **throws everything else**, so the missing first-turn snapshot surfaces
as `S3 error reading …` instead of returning `null`.

For contrast, `@aws-blocks/bb-file-bucket` builds its client **without** an explicit
region (`new S3Client({ customUserAgent })`), letting the AWS SDK resolve the region
from the Lambda's `AWS_REGION` — which is why FileBucket operations work everywhere.

## Reproduction

1. Build any `Agent` app (`npm create @aws-blocks/blocks-app`), add an `Agent`.
2. `npm run sandbox` (or `deploy`) with the deploy region set to **any region other
   than `us-east-1`** (e.g. `AWS_REGION=ap-northeast-1`).
3. Send one message. → `S3 error reading …/snapshot_latest.json`.

A `us-east-1` deploy works only by coincidence (the hardcoded default matches).

## Impact

Agents are **completely non-functional outside `us-east-1`** — the failure is on the
first message of every conversation.

## Suggested fix

Pass the region through (or omit it and let the SDK resolve `AWS_REGION`, as
`bb-file-bucket` does):

```js
(bucket) => new S3Storage({ bucket: bucket.fullId, region: process.env.AWS_REGION })
```

## Workaround (patch-package)

```diff
--- a/node_modules/@aws-blocks/bb-agent/dist/agent.aws.js
+++ b/node_modules/@aws-blocks/bb-agent/dist/agent.aws.js
-        super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, (bucket) => new S3Storage({ bucket: bucket.fullId }));
+        super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, (bucket) => new S3Storage({ bucket: bucket.fullId, region: process.env.AWS_REGION }));
```

Verified: after this patch, a `ap-northeast-1` deploy loads the snapshot correctly and
the agent responds normally.
