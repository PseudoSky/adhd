//! Derived domain types: identifiers, classification, normalized ratios,
//! and the helpers that turn wire records into the UML's normalized view.

use std::fmt;
use std::str::FromStr;

use rust_decimal::Decimal;

use crate::error::{Error, Result};
use crate::wire::{Endpoint, Modality, Model, Quantization};

/// `author/slug`, split on the first `/`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ModelId {
    author: String,
    slug: String,
}

impl ModelId {
    pub fn author(&self) -> &str {
        &self.author
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }
}

impl FromStr for ModelId {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.split_once('/') {
            Some((author, slug)) if !author.is_empty() && !slug.is_empty() => Ok(Self {
                author: author.to_owned(),
                slug: slug.to_owned(),
            }),
            _ => Err(Error::InvalidModelId(s.to_owned())),
        }
    }
}

impl fmt::Display for ModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.author, self.slug)
    }
}

/// Model category. The list endpoints are authoritative: image and video
/// models come from their own listings. `from_output_modalities` covers the
/// chat/embedding split for records that arrive without a listing context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModelKind {
    Chat,
    Embedding,
    Image,
    Video,
}

impl ModelKind {
    pub fn from_output_modalities(output: &[Modality]) -> Self {
        if output.contains(&Modality::Embeddings) {
            ModelKind::Embedding
        } else {
            ModelKind::Chat
        }
    }
}

impl Model {
    pub fn parsed_id(&self) -> Result<ModelId> {
        self.id.parse()
    }

    pub fn kind(&self) -> ModelKind {
        ModelKind::from_output_modalities(&self.architecture.output_modalities)
    }
}

/// Stable endpoint key: `"{tag}@{model_id}"`. Keyed on the provider slug,
/// never on the display name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EndpointId(String);

impl EndpointId {
    pub fn new(tag: &str, model_id: &str) -> Self {
        Self(format!("{tag}@{model_id}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for EndpointId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A fraction in `[0, 1]`. Uptime arrives as a 0–100 percent, so it is
/// divided by 100 on the way in.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct Ratio(f64);

impl Ratio {
    pub fn new(value: f64) -> Result<Self> {
        if value.is_finite() && (0.0..=1.0).contains(&value) {
            Ok(Self(value))
        } else {
            Err(Error::InvalidRatio(value))
        }
    }

    pub fn from_percent(percent: f64) -> Result<Self> {
        Self::new(percent / 100.0)
    }

    pub fn get(self) -> f64 {
        self.0
    }

    pub fn to_decimal(self) -> Decimal {
        Decimal::from_f64_retain(self.0).unwrap_or(Decimal::ZERO)
    }
}

/// Parse the raw modality expression, for example `"text+image->text"`, into
/// input and output modality sets. Returns `None` if there is no `->`.
pub fn parse_modality_expr(raw: &str) -> Option<(Vec<Modality>, Vec<Modality>)> {
    let (lhs, rhs) = raw.split_once("->")?;
    Some((parse_side(lhs), parse_side(rhs)))
}

fn parse_side(side: &str) -> Vec<Modality> {
    side.split('+')
        .map(|token| modality_from_token(token.trim()))
        .collect()
}

fn modality_from_token(token: &str) -> Modality {
    match token {
        "text" => Modality::Text,
        "image" => Modality::Image,
        "file" => Modality::File,
        "audio" => Modality::Audio,
        "video" => Modality::Video,
        "embeddings" => Modality::Embeddings,
        _ => Modality::Unknown,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolChoice {
    None,
    Auto,
    Required,
    Function,
}

impl Endpoint {
    pub fn id(&self) -> EndpointId {
        EndpointId::new(&self.tag, &self.model_id)
    }

    /// 5-minute uptime as a ratio. `None` when the API reports no data.
    pub fn uptime_5m(&self) -> Result<Option<Ratio>> {
        self.uptime_last_5m.map(Ratio::from_percent).transpose()
    }

    /// 30-minute uptime as a ratio. `None` when the API reports no data.
    pub fn uptime_30m(&self) -> Result<Option<Ratio>> {
        self.uptime_last_30m.map(Ratio::from_percent).transpose()
    }

    /// 1-day uptime as a ratio. `None` when the API reports no data.
    pub fn uptime_1d(&self) -> Result<Option<Ratio>> {
        self.uptime_last_1d.map(Ratio::from_percent).transpose()
    }

    pub fn supports_tool_choice(&self, choice: ToolChoice) -> bool {
        let s = self.supports_tool_choice;
        match choice {
            ToolChoice::None => s.none,
            ToolChoice::Auto => s.auto,
            ToolChoice::Required => s.required,
            ToolChoice::Function => s.function,
        }
    }

    pub fn supports_all(&self, params: &[String]) -> bool {
        params.iter().all(|p| self.supported_parameters.contains(p))
    }

    pub fn is_quantized_as(&self, q: Quantization) -> bool {
        self.quantization == q
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_id_splits_on_first_slash() {
        let id: ModelId = "openai/gpt-4o".parse().unwrap();
        assert_eq!(id.author(), "openai");
        assert_eq!(id.slug(), "gpt-4o");
        assert_eq!(id.to_string(), "openai/gpt-4o");
    }

    #[test]
    fn model_id_rejects_missing_parts() {
        assert!("openai".parse::<ModelId>().is_err());
        assert!("/gpt".parse::<ModelId>().is_err());
        assert!("openai/".parse::<ModelId>().is_err());
    }

    #[test]
    fn endpoint_id_keys_on_tag() {
        assert_eq!(
            EndpointId::new("azure", "openai/gpt-4o").as_str(),
            "azure@openai/gpt-4o"
        );
    }

    #[test]
    fn ratio_bounds_are_enforced() {
        assert!(Ratio::new(0.5).is_ok());
        assert!(Ratio::new(1.5).is_err());
        assert!(Ratio::new(f64::NAN).is_err());
        assert_eq!(Ratio::from_percent(100.0).unwrap().get(), 1.0);
    }

    #[test]
    fn modality_expression_parses_both_sides() {
        let (i, o) = parse_modality_expr("text+image->text").unwrap();
        assert_eq!(i, vec![Modality::Text, Modality::Image]);
        assert_eq!(o, vec![Modality::Text]);
        assert!(parse_modality_expr("text").is_none());
    }

    #[test]
    fn embeddings_output_classifies_as_embedding() {
        assert_eq!(
            ModelKind::from_output_modalities(&[Modality::Embeddings]),
            ModelKind::Embedding
        );
        assert_eq!(
            ModelKind::from_output_modalities(&[Modality::Text]),
            ModelKind::Chat
        );
    }
}
