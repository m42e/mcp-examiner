use std::{collections::BTreeMap, error::Error, fs, io, path::PathBuf};

use clap::{Parser, Subcommand, ValueEnum};
use mcp_examiner_core::{
    AppInfo, ConfigSourceKind, Redactor, ResolutionContext, RunStatus, SessionManager,
    import_config, parse_test_set, render_html_report, render_yaml_report, run_test_set,
};

#[derive(Debug, Parser)]
#[command(name = "mcp-examiner", version, about = "Inspect and test MCP servers")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Normalize and inspect an existing MCP client configuration.
    ImportConfig {
        path: PathBuf,
        #[arg(long, value_enum, default_value_t = SourceArg::Auto)]
        source: SourceArg,
    },
    /// Validate a JSON or YAML test set against the MCP Inspector test format.
    Validate { path: PathBuf },
    /// Run a JSON or YAML test set against a server from an MCP client config.
    Run {
        test: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        server: Option<String>,
        #[arg(long, default_value = "mcp-examiner-report.html")]
        report: PathBuf,
        #[arg(long, value_enum, default_value_t = SourceArg::Auto)]
        source: SourceArg,
        #[arg(long = "input", value_name = "ID=VALUE")]
        inputs: Vec<String>,
        #[arg(long)]
        workspace_folder: Option<PathBuf>,
    },
    /// Print the MCP protocol revisions understood by this build.
    Versions,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum SourceArg {
    Auto,
    VsCode,
    Claude,
    Inspector,
    Generic,
}

impl From<SourceArg> for ConfigSourceKind {
    fn from(value: SourceArg) -> Self {
        match value {
            SourceArg::Auto => Self::Auto,
            SourceArg::VsCode => Self::VsCode,
            SourceArg::Claude => Self::Claude,
            SourceArg::Inspector => Self::Inspector,
            SourceArg::Generic => Self::Generic,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    match Cli::parse().command {
        Command::ImportConfig { path, source } => {
            let input = fs::read_to_string(&path)?;
            let result = import_config(
                &input,
                source.into(),
                Some(path.to_string_lossy().into_owned()),
            )?;
            let result = Redactor::for_import_result(&result).redact_import_result(&result);
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::Validate { path } => {
            let input = fs::read_to_string(&path)?;
            let test_set = parse_test_set(&input)?;
            println!("Valid: {} ({} calls)", test_set.name, test_set.calls.len());
        }
        Command::Run {
            test,
            config,
            server,
            report,
            source,
            inputs,
            workspace_folder,
        } => {
            let test_set = parse_test_set(&fs::read_to_string(&test)?)?;
            let imported = import_config(
                &fs::read_to_string(&config)?,
                source.into(),
                Some(config.to_string_lossy().into_owned()),
            )?;
            let mut profile = select_profile(imported.profiles, server.as_deref())?;
            profile.trusted = true;
            let mut context = ResolutionContext::from_process();
            if let Some(workspace_folder) = workspace_folder {
                context.workspace_folder = Some(workspace_folder.to_string_lossy().into_owned());
            }
            context.inputs = parse_inputs(&inputs)?;

            let sessions = SessionManager::default();
            let result = run_test_set(&sessions, &profile, &context, &test_set).await;
            fs::write(&report, render_html_report(&result))?;
            let yaml_report = report.with_extension("yaml");
            fs::write(&yaml_report, render_yaml_report(&result)?)?;
            println!(
                "{}: {} passed, {} failed, {} errors ({} ms)",
                status_label(result.status),
                result.summary.passed,
                result.summary.failed,
                result.summary.errors,
                result.duration_ms
            );
            println!("HTML report: {}", report.display());
            println!("YAML report: {}", yaml_report.display());
            match result.status {
                RunStatus::Passed => {}
                RunStatus::Failed => std::process::exit(1),
                RunStatus::Error => std::process::exit(2),
            }
        }
        Command::Versions => {
            for version in AppInfo::current().protocol_versions {
                println!("{version}");
            }
        }
    }

    Ok(())
}

fn select_profile(
    profiles: Vec<mcp_examiner_core::ServerProfile>,
    requested: Option<&str>,
) -> Result<mcp_examiner_core::ServerProfile, io::Error> {
    if let Some(requested) = requested {
        return profiles
            .into_iter()
            .find(|profile| profile.name == requested)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("server '{requested}' was not found in the config"),
                )
            });
    }
    if profiles.len() == 1 {
        return profiles.into_iter().next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "config does not contain a server")
        });
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "--server is required when the config contains multiple servers",
    ))
}

fn parse_inputs(values: &[String]) -> Result<BTreeMap<String, String>, io::Error> {
    values
        .iter()
        .map(|value| {
            let (id, value) = value.split_once('=').ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("input '{value}' must use ID=VALUE syntax"),
                )
            })?;
            if id.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "input ID must not be empty",
                ));
            }
            Ok((id.to_owned(), value.to_owned()))
        })
        .collect()
}

fn status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Passed => "PASS",
        RunStatus::Failed => "FAIL",
        RunStatus::Error => "ERROR",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_input_values_without_truncating_equals() {
        let values = parse_inputs(&["token=a=b=c".to_owned()]).unwrap();
        assert_eq!(values["token"], "a=b=c");
    }
}
