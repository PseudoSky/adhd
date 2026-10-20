//! Typed client, wire types, and pricing functions for the OpenRouter public
//! catalog. The wire types mirror `../openapi.yaml`.
//!
//! ```no_run
//! # async fn demo() -> openrouter_pricing::Result<()> {
//! use openrouter_pricing::{CatalogClient, ModelQuery, Usage, cost_of};
//! use chrono::Utc;
//!
//! let client = CatalogClient::new()?;
//! let endpoints = client.get_model_endpoints("openai", "gpt-4o").await?;
//! let usage = Usage { input_tokens: 1_000, output_tokens: 200, ..Default::default() };
//! let cost = cost_of(&usage, &endpoints.endpoints[0].pricing, Utc::now())?;
//! println!("{cost}");
//! # Ok(()) }
//! ```

pub mod client;
pub mod domain;
pub mod error;
pub mod money;
pub mod pricing;
pub mod query;
pub mod wire;

pub use client::{CatalogClient, Page, DEFAULT_BASE_URL};
pub use domain::{EndpointId, ModelId, ModelKind, Ratio, ToolChoice};
pub use error::{Error, Result};
pub use money::{Currency, Money, Unit};
pub use pricing::{
    cheapest, compare, cost_of, filter, group_by_provider, override_applies, supporting,
    video_cost, EffectivePrices, EndpointFilter, PriceDelta, Usage,
};
pub use query::{Category, ModelQuery, Region, Sort};
