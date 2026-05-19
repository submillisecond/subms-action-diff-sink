# subms-action-diff-sink GitHub Action

Push a `subms-diff.json` (or any `SubMsBenchSummary`-shaped perf JSON) to one
or more external sinks. **13 built-in sinks**, multi-sink dispatch, and
soft-fail by default - a flaky webhook can't block your gate.

| group | sinks |
|---|---|
| text / chat       | `slack` |
| HTTP / REST       | `http` (alias `rest`), `splunk`, `newrelic`, `honeycomb` |
| cloud storage     | `s3`, `gcs`, `azure`  (presigned URL PUT) |
| metrics systems   | `prometheus`, `influxdb`, `datadog` |
| local             | `file`, `stdout` |

Pass a comma-separated list to push to several at once:

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input:        subms-diff.json
    sink:         "slack,prometheus,s3"
    webhook-url:  ${{ secrets.SLACK_WEBHOOK }}
    prometheus-pushgateway: http://gateway:9091
    s3-url:       ${{ secrets.S3_PRESIGNED_URL }}
```

Each sink runs independently; one failure isolates from the others. Set
`fail-on-sink-error: "true"` to surface webhook errors as CI errors.

## Inputs

| input | required when sink = | default | description |
|---|---|---|---|
| `input` | all | - | Path to perf JSON. Either `subms-diff.json` or a `SubMsBenchSummary` works. |
| `sink` | all | - | One sink name or comma-separated list. See the group table above for full list. |
| `webhook-url` | `slack`, `http` | `""` | Target URL. Use `${{ secrets.SLACK_WEBHOOK }}`. |
| `http-method` | `http` | `POST` | HTTP method. |
| `http-headers` | `http` | `""` | JSON object of extra headers. |
| `file-path` | `file` | `""` | Append-target path; each row becomes one JSON line. |
| `s3-url` | `s3` | `""` | Presigned PUT URL. Generate with `aws s3 presign`. |
| `gcs-url` | `gcs` | `""` | V4 signed PUT URL. Generate with `gcloud storage sign-url`. |
| `azure-url` | `azure` | `""` | SAS-token PUT URL. Generate with `az storage blob generate-sas`. |
| `prometheus-pushgateway` | `prometheus` | `""` | Pushgateway base URL. |
| `prometheus-job` | `prometheus` | `subms-action-diff` | Job label. |
| `influx-url` | `influxdb` | `""` | Write API URL with org/bucket/precision query string. |
| `influx-token` | `influxdb` | `""` | API token. Use a secret. |
| `datadog-api-key` | `datadog` | `""` | API key. Use a secret. |
| `datadog-site` | `datadog` | `datadoghq.com` | Site for EU / federal etc. |
| `splunk-url` | `splunk` | `""` | HEC endpoint (e.g. `https://splunk:8088/services/collector`). |
| `splunk-token` | `splunk` | `""` | HEC token. Use a secret. |
| `newrelic-license-key` | `newrelic` | `""` | License (ingest) key. Use a secret. |
| `newrelic-region` | `newrelic` | `us` | `us` or `eu`. |
| `honeycomb-api-key` | `honeycomb` | `""` | Team key. Use a secret. |
| `honeycomb-dataset` | `honeycomb` | `""` | Dataset name. |
| `honeycomb-region` | `honeycomb` | `us` | `us` or `eu`. |
| `metric-prefix` | metrics sinks | `subms_perf` | Prefix for all emitted metrics. |
| `tags` | optional | `""` | JSON object merged into every metric. |
| `only-on-regression` | optional | `false` | Skip push when `has_regression == false`. |
| `fail-on-sink-error` | optional | `false` | Hard-fail the action on sink error. |

## Outputs

| output | description |
|---|---|
| `pushed` | `"true"` if at least one event was forwarded. |
| `sink` | Echo of the sink type that ran. |

## Examples

### Slack page on red

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  if: steps.diff.outputs.has-regression == 'true'
  with:
    input: subms-diff.json
    sink: slack
    webhook-url: ${{ secrets.SLACK_PERF_WEBHOOK }}
    only-on-regression: "true"
```

### Prometheus pushgateway for trend dashboard

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: prometheus
    prometheus-pushgateway: http://gateway.internal:9091
    prometheus-job: myorg-perf
    metric-prefix: myorg_perf
    tags: '{"branch":"${{ github.head_ref }}","sha":"${{ github.sha }}"}'
```

### InfluxDB v2 line protocol

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-summary.json
    sink: influxdb
    influx-url: https://influx.internal/api/v2/write?org=acme&bucket=perf&precision=ns
    influx-token: ${{ secrets.INFLUX_TOKEN }}
    tags: '{"service":"orderbook","commit":"${{ github.sha }}"}'
```

### Datadog metrics

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: datadog
    datadog-api-key: ${{ secrets.DATADOG_API_KEY }}
    datadog-site: datadoghq.eu
    metric-prefix: myorg.perf
```

### Generic HTTP webhook (Discord, PagerDuty, custom)

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: http
    webhook-url: ${{ secrets.PERF_WEBHOOK }}
    http-headers: '{"Authorization":"Bearer ${{ secrets.PERF_TOKEN }}"}'
```

### Pipe to anything (stdout JSON-line)

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: stdout
  | jq 'select(.delta_pct > 10)' > regressions.jsonl
```

### Archive to S3 (presigned URL)

```yaml
- name: Generate S3 PUT URL
  id: presign
  run: |
    URL=$(aws s3 presign s3://my-bucket/perf/${{ github.sha }}.json --expires-in 600)
    echo "url=$URL" >> "$GITHUB_OUTPUT"

- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: s3
    s3-url: ${{ steps.presign.outputs.url }}
```

(Same shape for `gcs` with `gcloud storage sign-url` or `azure` with
`az storage blob generate-sas`.)

### Splunk HEC

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: splunk
    splunk-url: https://splunk.internal:8088/services/collector
    splunk-token: ${{ secrets.SPLUNK_HEC_TOKEN }}
```

### New Relic Metric API

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: newrelic
    newrelic-license-key: ${{ secrets.NEW_RELIC_LICENSE_KEY }}
    newrelic-region: us
    metric-prefix: myorg.perf
```

### Honeycomb (one event per stage/metric)

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: honeycomb
    honeycomb-api-key: ${{ secrets.HONEYCOMB_API_KEY }}
    honeycomb-dataset: myorg-perf
```

### Multi-sink (Slack + S3 + Datadog in one step)

```yaml
- uses: ./.github/actions/subms-action-diff-sink
  with:
    input: subms-diff.json
    sink: "slack,s3,datadog"
    webhook-url:        ${{ secrets.SLACK_WEBHOOK }}
    s3-url:             ${{ secrets.S3_PRESIGNED_URL }}
    datadog-api-key:    ${{ secrets.DATADOG_API_KEY }}
    only-on-regression: "true"
```

The `pushed` output reports which sinks succeeded; `failed-sinks` reports
which (if any) failed.

## Payload shapes by sink

- **slack**: a `text:` block listing the top 5 regressing stages (diff) or per-stage p99 (summary).
- **http**: `{ workload, lang, tags, has_regression, rows: [...] }`. Rows have `{stage, metric, baseline_ns?, candidate_ns?, value_ns?, delta_ns?, delta_pct?}`.
- **prometheus**: text exposition; one gauge per `(stage, metric)` tuple, plus `<prefix>_has_regression` for diffs.
- **influxdb**: line protocol; measurement = `metric-prefix`; tags include `stage`, `metric`, and merged `tags`; fields = `candidate_ns`/`baseline_ns`/`delta_pct` for diffs, `value_ns` for summaries.
- **datadog**: v2 series API; gauge metrics under `<prefix>.candidate_ns` / `<prefix>.delta_pct` / `<prefix>.has_regression`.
- **stdout**: one JSON object per row, newline-delimited.
