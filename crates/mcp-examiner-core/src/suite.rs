use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SuiteError {
    #[error("test set is not valid YAML or JSON: {0}")]
    Parse(#[from] serde_yaml::Error),
    #[error("test set name must contain a non-whitespace character")]
    EmptyName,
    #[error("call {index} has an empty {field}")]
    EmptyCallField { index: usize, field: &'static str },
    #[error("call {index} expectation must configure at least one check")]
    EmptyExpectation { index: usize },
    #[error("call {index} has an invalid Rust regular expression: {message}")]
    InvalidPattern { index: usize, message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestSet {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub calls: Vec<TestCall>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TestCall {
    CallTool {
        name: String,
        #[serde(default)]
        arguments: Map<String, Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect: Option<ResponseExpectation>,
    },
    ReadResource {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect: Option<ResponseExpectation>,
    },
    GetPrompt {
        name: String,
        #[serde(default)]
        arguments: Map<String, Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect: Option<ResponseExpectation>,
    },
}

impl TestCall {
    pub fn operation(&self) -> &'static str {
        match self {
            Self::CallTool { .. } => "callTool",
            Self::ReadResource { .. } => "readResource",
            Self::GetPrompt { .. } => "getPrompt",
        }
    }

    pub fn target(&self) -> &str {
        match self {
            Self::CallTool { name, .. } | Self::GetPrompt { name, .. } => name,
            Self::ReadResource { uri, .. } => uri,
        }
    }

    pub fn expectation(&self) -> Option<&ResponseExpectation> {
        match self {
            Self::CallTool { expect, .. }
            | Self::ReadResource { expect, .. }
            | Self::GetPrompt { expect, .. } => expect.as_ref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseExpectation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contains: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionOutcome {
    pub kind: String,
    pub passed: bool,
    pub message: String,
}

pub fn parse_test_set(input: &str) -> Result<TestSet, SuiteError> {
    let test_set: TestSet = serde_yaml::from_str(input)?;
    validate_test_set(&test_set)?;
    Ok(test_set)
}

pub fn validate_test_set(test_set: &TestSet) -> Result<(), SuiteError> {
    if test_set.name.trim().is_empty() {
        return Err(SuiteError::EmptyName);
    }

    for (offset, call) in test_set.calls.iter().enumerate() {
        let index = offset + 1;
        if call.target().is_empty() {
            let field = match call {
                TestCall::ReadResource { .. } => "uri",
                _ => "name",
            };
            return Err(SuiteError::EmptyCallField { index, field });
        }
        if let Some(expectation) = call.expectation() {
            if expectation.contains.is_none()
                && expectation.pattern.is_none()
                && expectation.json.is_none()
            {
                return Err(SuiteError::EmptyExpectation { index });
            }
            if let Some(pattern) = &expectation.pattern {
                Regex::new(pattern).map_err(|error| SuiteError::InvalidPattern {
                    index,
                    message: error.to_string(),
                })?;
            }
        }
    }
    Ok(())
}

pub fn assert_response(
    response: &Value,
    expectation: Option<&ResponseExpectation>,
) -> Vec<AssertionOutcome> {
    let Some(expectation) = expectation else {
        return Vec::new();
    };
    let serialized = serde_json::to_string(response).unwrap_or_default();
    let mut outcomes = Vec::new();

    if let Some(expected) = &expectation.contains {
        let passed = serialized.contains(expected);
        outcomes.push(AssertionOutcome {
            kind: "contains".to_owned(),
            passed,
            message: if passed {
                format!("response contains {expected:?}")
            } else {
                format!("response does not contain {expected:?}")
            },
        });
    }
    if let Some(pattern) = &expectation.pattern {
        let passed = Regex::new(pattern).is_ok_and(|pattern| pattern.is_match(&serialized));
        outcomes.push(AssertionOutcome {
            kind: "pattern".to_owned(),
            passed,
            message: if passed {
                format!("response matches /{pattern}/")
            } else {
                format!("response does not match /{pattern}/")
            },
        });
    }
    if let Some(expected) = &expectation.json {
        let mismatch = partial_json_mismatch(expected, response, "$");
        outcomes.push(AssertionOutcome {
            kind: "json".to_owned(),
            passed: mismatch.is_none(),
            message: mismatch.unwrap_or_else(|| "partial JSON matches".to_owned()),
        });
    }
    outcomes
}

fn partial_json_mismatch(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => {
            for (key, expected_value) in expected {
                let child_path = format!("{path}/{key}");
                let Some(actual_value) = actual.get(key) else {
                    return Some(format!("missing value at {child_path}"));
                };
                if let Some(mismatch) =
                    partial_json_mismatch(expected_value, actual_value, &child_path)
                {
                    return Some(mismatch);
                }
            }
            None
        }
        (Value::Array(expected), Value::Array(actual)) => {
            if expected.len() != actual.len() {
                return Some(format!(
                    "array length at {path} is {}, expected {}",
                    actual.len(),
                    expected.len()
                ));
            }
            expected
                .iter()
                .zip(actual)
                .enumerate()
                .find_map(|(index, (expected, actual))| {
                    partial_json_mismatch(expected, actual, &format!("{path}/{index}"))
                })
        }
        _ if expected == actual => None,
        _ => Some(format!(
            "value at {path} is {}, expected {}",
            compact(actual),
            compact(expected)
        )),
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<unserializable>".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_schema_compatible_yaml() {
        let test_set = parse_test_set(
            r#"
name: Fixture checks
description: Exercises all supported calls
calls:
  - type: callTool
    name: echo
    arguments: { message: hello }
    expect:
      contains: hello
      pattern: '"isError":false'
      json:
        isError: false
  - type: readResource
    uri: fixture://readme
  - type: getPrompt
    name: greeting
    arguments: { name: Ada }
"#,
        )
        .unwrap();

        assert_eq!(test_set.name, "Fixture checks");
        assert_eq!(test_set.calls.len(), 3);
        assert_eq!(test_set.calls[0].operation(), "callTool");
    }

    #[test]
    fn rejects_empty_expectations_and_invalid_patterns() {
        let empty = parse_test_set(
            "name: bad\ncalls:\n  - type: readResource\n    uri: x\n    expect: {}\n",
        )
        .unwrap_err();
        assert!(matches!(empty, SuiteError::EmptyExpectation { index: 1 }));

        let pattern = parse_test_set(
            "name: bad\ncalls:\n  - type: readResource\n    uri: x\n    expect:\n      pattern: '[a-'\n",
        )
        .unwrap_err();
        assert!(matches!(
            pattern,
            SuiteError::InvalidPattern { index: 1, .. }
        ));
    }

    #[test]
    fn evaluates_all_expectation_types_with_paths() {
        let response = serde_json::json!({
            "content": [{"type": "text", "text": "hello Ada"}],
            "isError": false
        });
        let outcomes = assert_response(
            &response,
            Some(&ResponseExpectation {
                contains: Some("hello".to_owned()),
                pattern: Some("Ada".to_owned()),
                json: Some(serde_json::json!({
                    "content": [{"type": "text", "text": "wrong"}]
                })),
            }),
        );

        assert_eq!(outcomes.len(), 3);
        assert!(outcomes[0].passed);
        assert!(outcomes[1].passed);
        assert!(!outcomes[2].passed);
        assert!(outcomes[2].message.contains("$/content/0/text"));
    }
}
