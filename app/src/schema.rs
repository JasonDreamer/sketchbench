//! project.json の検証。作品全体の形は固定のJSON Schema、params と tracks はスケッチの宣言から作る。
//! 作ったスキーマは .cache/schema.json に置く(AIやエディタが読める)。

use std::path::Path;

use serde_json::{json, Value};

fn type_schema(t: &str) -> Value {
    match t {
        "float" => json!({ "type": "number" }),
        "int" => json!({ "type": "integer" }),
        "bool" => json!({ "type": "boolean" }),
        "color" => json!({ "type": "string", "pattern": "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" }),
        "vec2" => json!({ "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 }),
        "curve" => json!({ "type": "array", "items": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 } }),
        "list<text>" => json!({ "type": "array", "items": { "type": "string" } }),
        _ => json!({ "type": "string" }),
    }
}

fn param_type(decl: &Value) -> String {
    decl["type"].as_str().unwrap_or("float").to_string()
}

/// レイヤー1つ分のスキーマ(params と tracks を宣言の型で縛る)
fn layer_schema(decl: &Value) -> Value {
    let mut params = serde_json::Map::new();
    for (name, d) in decl["params"].as_object().into_iter().flatten() {
        let mut ts = type_schema(&param_type(d));
        if let Some(opts) = d["options"].as_array() {
            ts = json!({ "enum": opts });
        }
        params.insert(name.clone(), json!({ "oneOf": [ ts.clone(), { "type": "object", "required": ["value"], "properties": { "value": ts, "keys": { "type": "array" } } } ] }));
    }
    let mut tracks = serde_json::Map::new();
    for (name, d) in decl["tracks"].as_object().into_iter().flatten() {
        let mut fields = serde_json::Map::new();
        for (f, t) in d["fields"].as_object().into_iter().flatten() {
            fields.insert(f.clone(), type_schema(t.as_str().unwrap_or("text")));
        }
        tracks.insert(
            name.clone(),
            json!({
                "type": "object",
                "additionalProperties": {
                    "type": "object",
                    "required": ["start", "end"],
                    "properties": {
                        "start": { "type": "integer", "minimum": 0 },
                        "end": { "type": "integer", "minimum": 1 },
                        "value": { "type": "object", "properties": fields, "additionalProperties": false },
                    },
                },
            }),
        );
    }
    json!({
        "type": "object",
        "properties": {
            "params": { "type": "object", "properties": params, "additionalProperties": false },
            "tracks": { "type": "object", "properties": tracks, "additionalProperties": false },
        },
    })
}

fn project_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["version", "width", "height", "fps", "duration", "layers"],
        "properties": {
            "version": { "type": "integer" },
            "width": { "type": "integer", "minimum": 16, "maximum": 16384 },
            "height": { "type": "integer", "minimum": 16, "maximum": 16384 },
            "fps": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 2, "maxItems": 2 },
            "duration": { "type": "integer", "minimum": 1 },
            "seed": { "type": "integer" },
            "bpm": { "type": "number", "exclusiveMinimum": 0 },
            "beatOffset": { "type": "integer" },
            "audio": { "type": "array", "items": { "type": "object", "required": ["asset"], "properties": { "asset": { "type": "string" }, "offset": { "type": "integer" }, "gain": { "type": "number" } } } },
            "markers": { "type": "array", "items": { "type": "object", "required": ["name", "start"], "properties": { "name": { "type": "string" }, "start": { "type": "integer" }, "end": { "type": "integer" } } } },
            "eventMap": { "type": "object", "additionalProperties": { "type": "object" } },
            "ccMap": { "type": "object", "additionalProperties": { "type": "object", "required": ["cc"], "properties": { "cc": { "type": "integer", "minimum": 0, "maximum": 127 }, "channel": { "type": "integer" }, "min": { "type": "number" }, "max": { "type": "number" }, "source": { "type": "string" } } } },
            "layers": {
                "type": "array",
                "items": { "type": "object", "required": ["id", "sketch"], "properties": { "id": { "type": "string" }, "sketch": { "type": "string" }, "params": { "type": "object" }, "tracks": { "type": "object" } } },
            },
        },
    })
}

/// 検証して、エラーの一覧(場所と理由)を返す。スキーマも .cache/schema.json に書く
pub fn validate(dir: &Path) -> Value {
    let text = match std::fs::read_to_string(dir.join("project.json")) {
        Ok(t) => t,
        Err(e) => return json!({ "errors": [format!("project.json を読めない: {e}")] }),
    };
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return json!({ "errors": [format!("project.json が正しいJSONではない: {e}")] }),
    };
    let mut errors = vec![];
    let check = |schema: &Value, inst: &Value, prefix: &str, errors: &mut Vec<String>| {
        if let Ok(val) = jsonschema::validator_for(schema) {
            for e in val.iter_errors(inst) {
                errors.push(format!("{prefix}{}: {e}", e.instance_path()));
            }
        }
    };
    let ps = project_schema();
    check(&ps, &v, "", &mut errors);
    let decls = crate::read_declarations(dir);
    let mut per_layer = serde_json::Map::new();
    for (i, l) in v["layers"].as_array().into_iter().flatten().enumerate() {
        let sketch = l["sketch"].as_str().unwrap_or("");
        let d = &decls[sketch];
        if d.is_null() {
            continue; // まだ一度も読み込めていないスケッチは宣言がない
        }
        let ls = layer_schema(d);
        check(&ls, l, &format!("/layers/{i}"), &mut errors);
        per_layer.insert(sketch.to_string(), ls);
    }
    let cache = dir.join(".cache");
    let _ = std::fs::create_dir_all(&cache);
    let _ = std::fs::write(cache.join("schema.json"), serde_json::to_string_pretty(&json!({ "project": ps, "layersBySketch": per_layer })).unwrap_or_default());
    json!({ "errors": errors, "schema": ".cache/schema.json" })
}

/// project.json が壊れている間は、Rustコアからの書き込みを止める(外の修正を上書きしない)
pub fn check_op_allowed(dir: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(dir.join("project.json")).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&text).map(|_| ()).map_err(|e| format!("project.json が正しいJSONではないので書き込みを止めた。先に直すこと: {e}"))
}
