//! Tool surface for Amber: the 18 in-house memory/task/swarm tools (via `mcp::handle_tool_call`)
//! plus the four file/command builtins. One catalog drives the request; one dispatcher routes by
//! name and flattens every result into the neutral `ToolResult`.

use serde_json::Value;

use super::builtins;
use super::types::ToolResult;
use crate::mcp;

/// Build the combined tool list in Anthropic shape (`[{name, description, input_schema}]`).
///
/// `mcp::tools_catalog()` returns `{"tools":[…]}` with each schema under `inputSchema` (camelCase);
/// the Messages API expects a bare array with `input_schema` (snake_case), so we unwrap and rename.
pub fn build_tool_schemas() -> Value {
    let mut out: Vec<Value> = Vec::new();
    if let Some(arr) = mcp::tools_catalog().get("tools").and_then(|t| t.as_array()) {
        for tool in arr {
            let mut t = tool.clone();
            if let Some(obj) = t.as_object_mut() {
                if let Some(schema) = obj.remove("inputSchema") {
                    obj.insert("input_schema".to_string(), schema);
                }
            }
            out.push(t);
        }
    }
    out.extend(builtins::tool_schemas());
    Value::Array(out)
}

/// Dispatch a single tool call synchronously (run on the blocking pool by the agent loop).
///
/// MCP results have the shape `{content:[{type:"text",text}], isError?}` — we flatten the text and
/// honor `isError`. An `Err` from either source becomes an `is_error` result so the model recovers.
pub fn dispatch_blocking(
    tool_use_id: &str,
    name: &str,
    input: Value,
    project_path: Option<&str>,
) -> ToolResult {
    let project_path = match project_path {
        Some(p) => p,
        None => {
            return error_result(
                tool_use_id,
                name,
                "This tool needs an open project. Open a folder in Bridge and try again.",
            )
        }
    };

    let (content, is_error) = if builtins::is_builtin(name) {
        match builtins::dispatch(name, &input, project_path) {
            Ok(text) => (text, false),
            Err(e) => (e, true),
        }
    } else {
        match mcp::handle_tool_call(name, Some(input), project_path) {
            Ok(val) => flatten_mcp_result(&val),
            Err(e) => (e, true),
        }
    };

    ToolResult {
        tool_use_id: tool_use_id.to_string(),
        name: name.to_string(),
        content,
        is_error,
    }
}

/// Extract the concatenated text and error flag from an MCP tool result value.
fn flatten_mcp_result(val: &Value) -> (String, bool) {
    let is_error = val.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    let text = val
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    (text, is_error)
}

fn error_result(tool_use_id: &str, name: &str, msg: &str) -> ToolResult {
    ToolResult {
        tool_use_id: tool_use_id.to_string(),
        name: name.to_string(),
        content: msg.to_string(),
        is_error: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_is_anthropic_shaped_and_includes_builtins() {
        let schemas = build_tool_schemas();
        let arr = schemas.as_array().unwrap();
        // 18 MCP tools + 4 builtins.
        assert_eq!(arr.len(), 22);
        // Every entry uses snake_case input_schema, never camelCase inputSchema.
        for t in arr {
            assert!(t.get("input_schema").is_some(), "missing input_schema: {}", t["name"]);
            assert!(t.get("inputSchema").is_none(), "leaked inputSchema: {}", t["name"]);
        }
        let names: Vec<&str> = arr.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"create_memory"));
        assert!(names.contains(&"run_command"));
    }

    #[test]
    fn flattens_mcp_text_and_error() {
        let ok = json!({ "content": [{ "type": "text", "text": "done" }] });
        assert_eq!(flatten_mcp_result(&ok), ("done".to_string(), false));

        let err = json!({ "content": [{ "type": "text", "text": "boom" }], "isError": true });
        assert_eq!(flatten_mcp_result(&err), ("boom".to_string(), true));
    }

    #[test]
    fn builtin_without_project_is_an_error_result() {
        let r = dispatch_blocking("t1", "read_file", json!({ "path": "x" }), None);
        assert!(r.is_error);
        assert_eq!(r.tool_use_id, "t1");
    }
}
