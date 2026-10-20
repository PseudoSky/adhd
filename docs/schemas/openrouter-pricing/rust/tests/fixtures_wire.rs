//! Every captured live response must deserialize into the wire types, and the
//! values the spec promises must hold on real data.

use openrouter_pricing::wire::{
    EndpointListResponse, ImageModelListResponse, JwksResponse, ModelCountResponse,
    ModelEndpointsResponse, ModelListResponse, ModelResponse, ProviderListResponse,
    VideoModelListResponse,
};
use std::str::FromStr;

use chrono::Utc;
use openrouter_pricing::wire::{Modality, ParamKind};
use openrouter_pricing::{cost_of, ModelKind, Usage};

const MODELS: &str = include_str!("fixtures/models_list.json");
const MODEL: &str = include_str!("fixtures/model_gpt4o.json");
const MODEL_ENDPOINTS: &str = include_str!("fixtures/model_gpt4o_endpoints.json");
const ZDR: &str = include_str!("fixtures/endpoints_zdr.json");
const PROVIDERS: &str = include_str!("fixtures/providers.json");
const EMBEDDINGS: &str = include_str!("fixtures/embeddings_models.json");
const IMAGES: &str = include_str!("fixtures/images_models.json");
const VIDEOS: &str = include_str!("fixtures/videos_models.json");
const JWKS: &str = include_str!("fixtures/jwks.json");
const COUNT: &str = include_str!("fixtures/models_count.json");

#[test]
fn model_list_deserializes() {
    let r: ModelListResponse = serde_json::from_str(MODELS).unwrap();
    assert!(!r.data.is_empty());
    for m in &r.data {
        m.parsed_id().unwrap();
        assert!(
            m.pricing.prompt.parse::<f64>().is_ok(),
            "prompt price is numeric: {}",
            m.id
        );
    }
}

#[test]
fn model_list_contains_overrides_and_reasoning() {
    let r: ModelListResponse = serde_json::from_str(MODELS).unwrap();
    assert!(r.data.iter().any(|m| !m.pricing.overrides.is_empty()));
    assert!(r.data.iter().any(|m| m.reasoning.is_some()));
    assert!(r.data.iter().any(|m| m.alias_target.is_some()));
}

#[test]
fn single_model_matches_gpt4o() {
    let r: ModelResponse = serde_json::from_str(MODEL).unwrap();
    assert_eq!(r.data.id, "openai/gpt-4o");
    assert_eq!(r.data.kind(), ModelKind::Chat);
    assert_eq!(r.data.pricing.prompt, "0.0000025");
}

#[test]
fn model_endpoints_deserialize_and_price_gpt4o() {
    let r: ModelEndpointsResponse = serde_json::from_str(MODEL_ENDPOINTS).unwrap();
    let azure = r
        .data
        .endpoints
        .iter()
        .find(|e| e.tag == "azure")
        .expect("azure endpoint present");
    assert_eq!(azure.pricing.prompt, "0.0000025");
    assert_eq!(azure.pricing.completion, "0.00001");

    // $2.50 per 1M prompt tokens and $10 per 1M completion tokens.
    let usage = Usage {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        ..Default::default()
    };
    let cost = cost_of(&usage, &azure.pricing, Utc::now()).unwrap();
    assert_eq!(
        cost.amount,
        rust_decimal::Decimal::from_str("12.5").unwrap()
    );
}

#[test]
fn zdr_endpoints_deserialize_with_mixed_numeric_types() {
    let r: EndpointListResponse = serde_json::from_str(ZDR).unwrap();
    assert!(r.data.len() >= 12);
    // discount is observed as both integer 0 and fractional values in the feed.
    assert!(r.data.iter().any(|e| e.pricing.discount.is_some()));
    assert!(r.data.iter().any(|e| !e.native_tools.is_empty()));
    for e in &r.data {
        assert!(e
            .uptime_30m()
            .unwrap()
            .map_or(true, |u| (0.0..=1.0).contains(&u.get())));
    }
}

#[test]
fn providers_deserialize_with_nullable_fields() {
    let r: ProviderListResponse = serde_json::from_str(PROVIDERS).unwrap();
    assert!(r.data.iter().any(|p| p.datacenters.is_some()));
    // The feed sends null headquarters for some providers; those must
    // deserialize as None rather than failing the whole list.
    assert!(r.data.iter().any(|p| p.headquarters.is_none()));
}

#[test]
fn embedding_models_classify_as_embedding() {
    let r: ModelListResponse = serde_json::from_str(EMBEDDINGS).unwrap();
    assert!(!r.data.is_empty());
    for m in &r.data {
        assert_eq!(m.kind(), ModelKind::Embedding, "{}", m.id);
        assert!(m
            .architecture
            .output_modalities
            .contains(&Modality::Embeddings));
    }
}

#[test]
fn image_models_deserialize_with_typed_param_specs() {
    let r: ImageModelListResponse = serde_json::from_str(IMAGES).unwrap();
    assert!(!r.data.is_empty());
    let specs: Vec<_> = r
        .data
        .iter()
        .flat_map(|m| m.supported_parameters.values())
        .collect();
    let enum_with_values = specs
        .iter()
        .any(|s| s.kind == ParamKind::Enum && s.values.as_ref().is_some_and(|v| !v.is_empty()));
    let range_with_bounds = specs
        .iter()
        .any(|s| s.kind == ParamKind::Range && s.min.is_some() && s.max.is_some());
    assert!(enum_with_values, "at least one enum parameter with values");
    assert!(
        range_with_bounds,
        "at least one range parameter with bounds"
    );
}

#[test]
fn video_models_split_price_and_quantity_skus() {
    let r: VideoModelListResponse = serde_json::from_str(VIDEOS).unwrap();
    let mut with_prices = 0;
    for v in &r.data {
        let prices = v.prices().unwrap();
        for (key, money) in &prices {
            assert!(key.starts_with("cents_"), "{key}");
            assert!(money.amount >= rust_decimal::Decimal::ZERO);
        }
        if !prices.is_empty() {
            with_prices += 1;
        }
        for key in v.quantities().keys() {
            assert!(!key.starts_with("cents_"), "{key}");
        }
    }
    assert!(with_prices > 0);
}

#[test]
fn jwks_and_count_deserialize() {
    let jwks: JwksResponse = serde_json::from_str(JWKS).unwrap();
    assert!(!jwks.keys.is_empty());
    assert_eq!(jwks.keys[0].kty, "EC");
    let count: ModelCountResponse = serde_json::from_str(COUNT).unwrap();
    assert!(count.data.count > 0);
}
