//! Wire types: serde mirrors of `../openapi.yaml`.
//!
//! Field names match the API exactly (snake_case). Nullable and absent fields
//! are `Option`. Numeric price fields stay as strings so no precision is lost
//! before the pricing functions parse them with `rust_decimal`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Input or output modality. Unknown values map to `Unknown` so a new
/// modality from the API does not fail deserialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Text,
    Image,
    File,
    Audio,
    Video,
    Embeddings,
    #[serde(other)]
    Unknown,
}

/// Endpoint quantization. `unknown` is the API default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quantization {
    Fp32,
    Fp16,
    Bf16,
    Fp8,
    Fp4,
    Nvfp4,
    Mxfp4,
    Int8,
    Int4,
    #[serde(other)]
    Unknown,
}

/// Weekday as sent in `utc_days`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DayOfWeek {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageLinks {
    #[serde(default)]
    pub next: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelLinks {
    pub details: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Architecture {
    pub tokenizer: String,
    #[serde(default)]
    pub instruct_type: Option<String>,
    pub modality: String,
    pub input_modalities: Vec<Modality>,
    pub output_modalities: Vec<Modality>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopProvider {
    #[serde(default)]
    pub context_length: Option<u64>,
    #[serde(default)]
    pub max_completion_tokens: Option<u64>,
    pub is_moderated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DefaultParameters {
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub top_k: Option<f64>,
    #[serde(default)]
    pub frequency_penalty: Option<f64>,
    #[serde(default)]
    pub presence_penalty: Option<f64>,
    #[serde(default)]
    pub repetition_penalty: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reasoning {
    #[serde(default)]
    pub mandatory: bool,
    #[serde(default)]
    pub default_enabled: Option<bool>,
    #[serde(default)]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub supported_efforts: Vec<String>,
    #[serde(default)]
    pub supports_max_tokens: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AliasTarget {
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignArenaEntry {
    pub arena: String,
    pub category: String,
    pub elo: i64,
    pub rank: i64,
    pub win_rate: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ArtificialAnalysis {
    #[serde(default)]
    pub intelligence_index: Option<f64>,
    #[serde(default)]
    pub coding_index: Option<f64>,
    #[serde(default)]
    pub agentic_index: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Benchmarks {
    #[serde(default)]
    pub artificial_analysis: Option<ArtificialAnalysis>,
    #[serde(default)]
    pub design_arena: Vec<DesignArenaEntry>,
}

/// Token and media prices. Values are decimal strings in USD (per token for
/// token fields, per call for `request` and `web_search`, per image for
/// `image` and `image_output`). `discount` is observed on endpoints only.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Pricing {
    pub prompt: String,
    pub completion: String,
    #[serde(default)]
    pub request: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub image_output: Option<String>,
    #[serde(default)]
    pub image_token: Option<String>,
    #[serde(default)]
    pub audio: Option<String>,
    #[serde(default)]
    pub audio_output: Option<String>,
    #[serde(default)]
    pub input_audio_cache: Option<String>,
    #[serde(default)]
    pub input_cache_read: Option<String>,
    #[serde(default)]
    pub input_cache_write: Option<String>,
    #[serde(default)]
    pub input_cache_write_1h: Option<String>,
    #[serde(default)]
    pub internal_reasoning: Option<String>,
    #[serde(default)]
    pub web_search: Option<String>,
    #[serde(default)]
    pub discount: Option<f64>,
    #[serde(default)]
    pub overrides: Vec<PricingOverride>,
}

/// A price that replaces the base price when its conditions match. Conditions
/// are the UTC window (`utc_start`, `utc_end`, `utc_days`) and
/// `min_prompt_tokens`. Only the overridden price fields are present.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PricingOverride {
    #[serde(default)]
    pub utc_start: Option<u32>,
    #[serde(default)]
    pub utc_end: Option<u32>,
    #[serde(default)]
    pub utc_days: Option<Vec<DayOfWeek>>,
    #[serde(default)]
    pub min_prompt_tokens: Option<u64>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub completion: Option<String>,
    #[serde(default)]
    pub audio: Option<String>,
    #[serde(default)]
    pub input_audio_cache: Option<String>,
    #[serde(default)]
    pub input_cache_read: Option<String>,
    #[serde(default)]
    pub input_cache_write: Option<String>,
    #[serde(default)]
    pub input_cache_write_1h: Option<String>,
}

/// A catalog model (chat, embedding, image, or video listing row for the
/// chat/embedding shapes; see `ImageModel` and `VideoModel` for the others).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub canonical_slug: String,
    #[serde(default)]
    pub hugging_face_id: Option<String>,
    pub name: String,
    pub created: i64,
    pub description: String,
    pub context_length: u64,
    pub architecture: Architecture,
    pub pricing: Pricing,
    pub top_provider: TopProvider,
    #[serde(default)]
    pub per_request_limits: Option<serde_json::Value>,
    pub supported_parameters: Vec<String>,
    pub default_parameters: DefaultParameters,
    #[serde(default)]
    pub supported_voices: Option<Vec<String>>,
    #[serde(default)]
    pub knowledge_cutoff: Option<String>,
    #[serde(default)]
    pub expiration_date: Option<String>,
    pub links: ModelLinks,
    #[serde(default)]
    pub reasoning: Option<Reasoning>,
    #[serde(default)]
    pub alias_target: Option<AliasTarget>,
    #[serde(default)]
    pub benchmarks: Option<Benchmarks>,
}

/// Support flags for tool choice on an endpoint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolChoiceSupport {
    #[serde(default)]
    pub none: bool,
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub function: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeTool {
    #[serde(rename = "type")]
    pub kind: String,
}

/// One provider's serving endpoint for a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Endpoint {
    pub name: String,
    pub model_id: String,
    pub model_name: String,
    pub context_length: u64,
    pub pricing: Pricing,
    /// Display name of the provider.
    pub provider_name: String,
    /// Stable provider slug. Key on this, not on `provider_name`.
    pub tag: String,
    pub quantization: Quantization,
    #[serde(default)]
    pub max_completion_tokens: Option<u64>,
    #[serde(default)]
    pub max_prompt_tokens: Option<u64>,
    #[serde(default)]
    pub supported_parameters: Vec<String>,
    #[serde(default)]
    pub supports_tool_choice: ToolChoiceSupport,
    /// Observed values 0, -2, -5. Meaning not yet documented.
    pub status: i64,
    #[serde(default)]
    pub uptime_last_5m: Option<f64>,
    #[serde(default)]
    pub uptime_last_30m: Option<f64>,
    #[serde(default)]
    pub uptime_last_1d: Option<f64>,
    #[serde(default)]
    pub latency_last_30m: Option<f64>,
    #[serde(default)]
    pub throughput_last_30m: Option<f64>,
    #[serde(default)]
    pub supports_implicit_caching: bool,
    #[serde(default)]
    pub supports_voice_cloning: bool,
    #[serde(default)]
    pub supports_multiple_audio_references: bool,
    #[serde(default)]
    pub supports_image_reference: bool,
    #[serde(default)]
    pub native_tools: BTreeMap<String, NativeTool>,
}

/// Response of `GET /models/{author}/{slug}/endpoints`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelWithEndpoints {
    pub id: String,
    pub name: String,
    pub created: i64,
    pub description: String,
    pub architecture: Architecture,
    pub endpoints: Vec<Endpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provider {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub privacy_policy_url: Option<String>,
    #[serde(default)]
    pub terms_of_service_url: Option<String>,
    #[serde(default)]
    pub status_page_url: Option<String>,
    #[serde(default)]
    pub headquarters: Option<String>,
    /// Country codes, for example `US` or `SG`.
    #[serde(default)]
    pub datacenters: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamKind {
    Boolean,
    Enum,
    Range,
    #[serde(other)]
    Unknown,
}

/// One image generation parameter. `values` applies to `enum`; `min` and
/// `max` apply to `range`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageParamSpec {
    #[serde(rename = "type")]
    pub kind: ParamKind,
    #[serde(default)]
    pub values: Option<Vec<String>>,
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageArchitecture {
    pub input_modalities: Vec<Modality>,
    pub output_modalities: Vec<Modality>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageModel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created: i64,
    pub architecture: ImageArchitecture,
    pub supported_parameters: BTreeMap<String, ImageParamSpec>,
    pub supports_streaming: bool,
    /// Relative API path to the model's endpoints.
    pub endpoints: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpscaleFactor {
    pub min: f64,
    pub max: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoModel {
    pub id: String,
    pub canonical_slug: String,
    #[serde(default)]
    pub hugging_face_id: Option<String>,
    pub name: String,
    pub description: String,
    pub created: i64,
    #[serde(default)]
    pub supported_resolutions: Option<Vec<String>>,
    #[serde(default)]
    pub supported_aspect_ratios: Option<Vec<String>>,
    #[serde(default)]
    pub supported_sizes: Option<Vec<String>>,
    #[serde(default)]
    pub supported_durations: Option<Vec<i64>>,
    #[serde(default)]
    pub supported_frame_images: Option<Vec<String>>,
    #[serde(default)]
    pub upscale_factor: Option<UpscaleFactor>,
    #[serde(default)]
    pub creativity: Option<Vec<i64>>,
    #[serde(default)]
    pub generate_audio: Option<bool>,
    #[serde(default)]
    pub seed: Option<bool>,
    /// Mixed map: keys starting with `cents_` are prices in cents; other keys
    /// are quantities (durations, token counts, image counts). See
    /// `VideoModel::split_skus` in `pricing.rs`.
    pub pricing_skus: BTreeMap<String, String>,
    pub allowed_passthrough_parameters: Vec<String>,
}

/// JSON Web Key (RFC 7517). Public key material only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub crv: Option<String>,
    pub kid: String,
    #[serde(default)]
    pub x: Option<String>,
    #[serde(default)]
    pub y: Option<String>,
    pub alg: String,
    #[serde(rename = "use")]
    pub use_: String,
}

// ---- Response envelopes -----------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelListResponse {
    pub data: Vec<Model>,
    #[serde(default)]
    pub total_count: Option<u64>,
    #[serde(default)]
    pub links: Option<PageLinks>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelResponse {
    pub data: Model,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCount {
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCountResponse {
    pub data: ModelCount,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelEndpointsResponse {
    pub data: ModelWithEndpoints,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EndpointListResponse {
    pub data: Vec<Endpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderListResponse {
    pub data: Vec<Provider>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageModelListResponse {
    pub data: Vec<ImageModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoModelListResponse {
    pub data: Vec<VideoModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JwksResponse {
    pub keys: Vec<Jwk>,
}
