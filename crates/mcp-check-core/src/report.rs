use std::fmt::Write;

use crate::{RunStatus, TestRunResult};

pub fn render_yaml_report(result: &TestRunResult) -> Result<String, serde_yaml::Error> {
    serde_yaml::to_string(result)
}

pub fn render_html_report(result: &TestRunResult) -> String {
    let title = escape_html(&result.name);
    let status = status_label(result.status);
    let mut calls = String::new();
    let mut call_links = String::new();
    for call in &result.calls {
        let definition = serde_json::to_string_pretty(&call.definition).unwrap_or_default();
        let response = call
            .response
            .as_ref()
            .and_then(|response| serde_json::to_string_pretty(response).ok())
            .unwrap_or_default();
        let assertions = call
            .assertions
            .iter()
            .map(|assertion| {
                format!(
                    "<li class=\"{}\"><strong>{}</strong> {}</li>",
                    if assertion.passed { "passed" } else { "failed" },
                    escape_html(&assertion.kind),
                    escape_html(&assertion.message)
                )
            })
            .collect::<String>();
        let error = call.error.as_deref().map_or_else(String::new, |error| {
            format!("<p class=\"error\">{}</p>", escape_html(error))
        });
        let _ = write!(
            call_links,
            "<a href=\"#call-{}\"><span>#{}</span><strong>{}</strong><small>{}</small></a>",
            call.index,
            call.index,
            escape_html(&call.operation),
            escape_html(&call.target)
        );
        let _ = write!(
            calls,
            "<details id=\"call-{}\" class=\"call {}\" open><summary><span>#{}</span><strong>{}</strong><code>{}</code><b>{}</b><small>{} ms</small></summary>{}<ul>{}</ul><div class=\"call-evidence\"><section><h3>Call and expectations</h3><pre>{}</pre></section><section><h3>Response</h3><pre>{}</pre></section></div></details>",
            call.index,
            status_label(call.status),
            call.index,
            escape_html(&call.operation),
            escape_html(&call.target),
            status_label(call.status),
            call.duration_ms,
            error,
            assertions,
            escape_html(&definition),
            escape_html(&response)
        );
    }
    let connection_error = result
        .connection_error
        .as_deref()
        .map_or_else(String::new, |error| {
            format!(
                "<section class=\"banner error\">{}</section>",
                escape_html(error)
            )
        });
    let events = result
        .protocol_events
        .iter()
        .map(|event| {
            format!(
                "<tr><td>{}</td><td>{} ms</td><td>{:?}</td><td>{}</td><td><code>{}</code></td></tr>",
                event.sequence,
                event.elapsed_ms,
                event.direction,
                escape_html(&event.method),
                escape_html(&serde_json::to_string(&event.payload).unwrap_or_default())
            )
        })
        .collect::<String>();
    let http_events = result
        .http_observations
        .iter()
        .map(|event| {
            let body = serde_json::json!({
                "request": event.request_body,
                "response": event.response_body,
            });
            format!(
                "<tr><td>{}</td><td>{} ms</td><td>{}</td><td>{}</td><td>{}</td><td><code>{}</code></td></tr>",
                event.sequence,
                event.elapsed_ms,
                escape_html(&event.method),
                escape_html(&event.url),
                escape_html(event.response_kind.as_deref().unwrap_or("error")),
                escape_html(&serde_json::to_string(&body).unwrap_or_default())
            )
        })
        .collect::<String>();
    let data = serde_json::to_string(result)
        .unwrap_or_else(|_| "{}".to_owned())
        .replace('<', "\\u003c");
    let profile =
        escape_html(&serde_json::to_string_pretty(&result.server_profile).unwrap_or_default());
    let server_snapshot =
        escape_html(&serde_json::to_string_pretty(&result.server_snapshot).unwrap_or_default());
    let server_name = escape_html(&result.server_name);
    let protocol = escape_html(
        result
            .protocol_version
            .as_deref()
            .unwrap_or("not connected"),
    );
    let total = result.summary.total;
    let passed = result.summary.passed;
    let failed = result.summary.failed;
    let errors = result.summary.errors;
    let duration = result.duration_ms;

    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>{title} - MCP Check</title><style>{STYLE}{NAV_STYLE}</style></head><body><aside class="report-nav"><a class="nav-brand" href="#top"><strong>MCP Check</strong><span>Test report</span></a><nav><a href="#summary">Summary</a><a href="#configuration">Configuration</a><a href="#server">Server information</a><a href="#calls">Calls and expectations</a><a href="#protocol">Protocol timeline</a><a href="#http">HTTP transport</a><div class="nav-call-list">{call_links}</div></nav></aside><div class="report-page"><header id="top"><div><p>MCP Check report</p><h1>{title}</h1><span>{server_name}</span></div><b class="run-status {status}">{status}</b></header><main>{connection_error}<section id="summary" class="summary"><div><span>Total</span><strong>{total}</strong></div><div><span>Passed</span><strong>{passed}</strong></div><div><span>Failed</span><strong>{failed}</strong></div><div><span>Errors</span><strong>{errors}</strong></div><div><span>Duration</span><strong>{duration} ms</strong></div><div><span>Protocol</span><strong>{protocol}</strong></div></section><section class="context"><article id="configuration"><h2>Complete normalized server configuration</h2><pre>{profile}</pre></article><article id="server"><h2>Negotiated server information, capabilities and primitives</h2><pre>{server_snapshot}</pre></article></section><section id="calls" class="calls"><h2>Calls, expectations and responses</h2>{calls}</section><section id="protocol" class="timeline"><h2>Protocol timeline</h2><table><thead><tr><th>#</th><th>Time</th><th>Direction</th><th>Method</th><th>Payload</th></tr></thead><tbody>{events}</tbody></table></section><section id="http" class="timeline"><h2>HTTP transport</h2><table><thead><tr><th>#</th><th>Time</th><th>Method</th><th>URL</th><th>Response</th><th>Body</th></tr></thead><tbody>{http_events}</tbody></table></section></main></div><script type="application/json" id="mcp-check-run">{data}</script></body></html>"##,
    )
}

fn status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Passed => "passed",
        RunStatus::Failed => "failed",
        RunStatus::Error => "error",
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

const STYLE: &str = r#"
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#20231f;background:#f2f3ee}body{margin:0}header{display:flex;justify-content:space-between;align-items:center;padding:28px 5vw;color:#f4f5f0;background:#20241f}header p{margin:0 0 5px;color:#e66a50;font-size:12px;font-weight:800;text-transform:uppercase}h1{margin:0 0 5px;font-size:28px}header span{color:#b8beb4}.run-status{padding:8px 12px;border:1px solid currentColor;border-radius:4px;text-transform:uppercase}.passed{color:#28755b}.failed{color:#a36a16}.error{color:#a64231}main{width:min(1100px,90vw);margin:24px auto}.summary{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid #d3d7ce;background:#fff}.summary div{display:grid;gap:4px;padding:14px;border-right:1px solid #e1e4dc}.summary div:last-child{border:0}.summary span{color:#737970;font-size:11px;text-transform:uppercase}.summary strong{font-size:16px}.context{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.context details{min-width:0;background:#fff;border:1px solid #d3d7ce}.context summary{padding:12px;font-weight:700;cursor:pointer}.context pre{max-height:360px;overflow:auto;margin:0;padding:13px;color:#e5e9e1;background:#20241f}.calls{display:grid;gap:10px;margin-top:18px}.call{border:1px solid #d3d7ce;background:#fff}.call summary{display:grid;grid-template-columns:35px 130px 1fr 65px 70px;gap:10px;align-items:center;padding:13px;cursor:pointer}.call summary b{text-transform:uppercase}.call summary small{text-align:right}.call ul{margin:0;padding:0 34px 12px;list-style:none}.call li{padding:3px 0}.call li strong{display:inline-block;width:75px}.call pre{overflow:auto;margin:0;padding:14px;color:#e5e9e1;background:#20241f;font-size:12px}.banner{margin-bottom:14px;padding:12px;background:#fff;border:1px solid currentColor}.timeline{margin-top:24px}.timeline table{width:100%;border-collapse:collapse;background:#fff;font-size:11px}.timeline th,.timeline td{padding:8px;border:1px solid #dfe2da;text-align:left;vertical-align:top}.timeline td:last-child{max-width:500px;overflow-wrap:anywhere}@media(max-width:760px){.summary,.context{grid-template-columns:1fr}.call summary{grid-template-columns:30px 1fr 60px}.call summary code,.call summary small{grid-column:2/4}.run-status{align-self:flex-start}}
"#;

const NAV_STYLE: &str = r#"
html{scroll-behavior:smooth;scroll-padding-top:16px}body{display:grid;grid-template-columns:220px minmax(0,1fr)}.report-page{min-width:0}.report-nav{position:sticky;top:0;height:100vh;overflow:auto;color:#dfe4dc;background:#171a16;border-right:1px solid #343a32}.nav-brand{display:grid;gap:3px;padding:22px 18px;color:#f2f4ef;text-decoration:none;border-bottom:1px solid #343a32}.nav-brand strong{font-size:15px}.nav-brand span{color:#929a90;font-size:10px;text-transform:uppercase}.report-nav nav{display:grid;padding:12px 8px}.report-nav nav>a{padding:8px 10px;color:#bbc2b8;text-decoration:none;border-radius:3px;font-size:11px;font-weight:700}.report-nav nav>a:hover{color:#fff;background:#2a2f28}.nav-call-list{display:grid;margin-top:12px;padding-top:10px;border-top:1px solid #343a32}.nav-call-list a{display:grid;grid-template-columns:25px 1fr;gap:2px 6px;padding:7px 10px;color:#adb5aa;text-decoration:none;font-size:9px}.nav-call-list a:hover{color:#fff;background:#242922}.nav-call-list span{grid-row:1/3;color:#697268}.nav-call-list strong,.nav-call-list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-call-list small{color:#747d72}.report-page>header{padding-left:4vw;padding-right:4vw}.report-page main{width:min(1100px,calc(100% - 48px))}.context article{min-width:0;background:#fff;border:1px solid #d3d7ce}.context article h2{min-height:38px;margin:0;padding:10px 12px;font-size:12px}.context article pre{max-height:360px;overflow:auto;margin:0;padding:13px;color:#e5e9e1;background:#20241f}.calls>h2{margin:0 0 10px;font-size:17px}.call-evidence{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#d3d7ce;border-top:1px solid #d3d7ce}.call-evidence section{min-width:0;background:#fff}.call-evidence h3{margin:0;padding:9px 13px;color:#656b61;font-size:10px;text-transform:uppercase}.call-evidence pre{height:100%;max-height:360px;box-sizing:border-box}.timeline{scroll-margin-top:16px}section,article,details{scroll-margin-top:16px}@media(max-width:800px){body{display:block}.report-nav{position:static;height:auto}.nav-brand{padding:14px 18px}.report-nav nav{display:flex;flex-wrap:wrap;gap:2px}.report-nav nav>a{padding:7px}.nav-call-list{display:none}.report-page main{width:calc(100% - 24px);margin:12px}.call-evidence{grid-template-columns:1fr}}@media print{body{display:block}.report-nav{display:none}.report-page main{width:100%;margin:12px 0}.call,.context article,.timeline{break-inside:avoid}.report-page>header{padding:18px 0}}
.call-evidence section{display:grid;grid-template-rows:auto minmax(0,1fr)}.call-evidence pre{height:auto}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CallRunResult, RunSummary};
    use serde_json::json;

    #[test]
    fn report_is_self_contained_and_escapes_server_content() {
        let result = TestRunResult {
            format_version: 1,
            name: "Hostile </title><script>alert(1)</script>".to_owned(),
            description: None,
            server_name: "fixture".to_owned(),
            server_profile: crate::ServerProfile {
                format_version: 1,
                name: "fixture".to_owned(),
                transport: crate::TransportConfig::Http {
                    url: "https://example.test/mcp".to_owned(),
                    headers: Default::default(),
                    oauth: None,
                },
                protocol: crate::ProtocolSelection::default(),
                source: crate::ProfileSource {
                    kind: crate::ConfigSourceKind::Generic,
                    path: None,
                    scope: None,
                },
                timeout_ms: None,
                trusted: true,
            },
            server_snapshot: None,
            protocol_version: Some("2025-11-25".to_owned()),
            status: RunStatus::Failed,
            started_at_unix_ms: 1,
            duration_ms: 2,
            summary: RunSummary {
                total: 1,
                passed: 0,
                failed: 1,
                errors: 0,
            },
            calls: vec![CallRunResult {
                index: 1,
                operation: "callTool".to_owned(),
                target: "echo".to_owned(),
                definition: serde_json::from_value(json!({
                    "type": "callTool",
                    "name": "echo",
                    "arguments": {"message": "hello"},
                    "expect": {"contains": "hello"}
                }))
                .unwrap(),
                status: RunStatus::Failed,
                duration_ms: 1,
                response: Some(json!({"text": "</script><img src=x>"})),
                assertions: Vec::new(),
                error: None,
            }],
            protocol_events: Vec::new(),
            http_observations: Vec::new(),
            connection_error: None,
            shutdown_error: None,
        };

        let report = render_html_report(&result);

        assert!(report.starts_with("<!doctype html>"));
        assert!(report.contains("default-src 'none'"));
        assert!(!report.contains("<script>alert(1)</script>"));
        assert!(!report.contains("</script><img"));
        assert!(!report.contains("src=\"http"));
        assert!(report.contains("class=\"report-nav\""));
        assert!(report.contains("href=\"#calls\""));
        assert!(report.contains("href=\"#call-1\""));
        assert!(report.contains("Call and expectations"));
        assert!(report.contains("&quot;message&quot;: &quot;hello&quot;"));
        assert!(report.contains("&quot;contains&quot;: &quot;hello&quot;"));
        let yaml = render_yaml_report(&result).unwrap();
        assert!(yaml.contains("serverProfile:"));
        assert!(yaml.contains("definition:"));
        assert!(yaml.contains("message: hello"));
        assert!(yaml.contains("expect:"));
        assert!(yaml.contains("contains: hello"));
    }
}
