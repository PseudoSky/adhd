//! Pricing functions: effective prices with overrides, cost of usage, blended
//! rates, endpoint filtering and ranking, price comparison, and video SKUs.
//!
//! Assumptions that the API does not yet confirm (kept here so they are easy
//! to find and change):
//! - When several overrides match, the first one in array order wins.
//! - `discount` is reported but NOT applied to costs.
//! - `Usage::input_tokens` excludes cache reads and writes.
//! - A missing cache price bills cache tokens at the prompt rate.
//! - A missing `request`, `image_output`, or `web_search` price means no charge.

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};
use rust_decimal::Decimal;

use crate::domain::{Ratio, ToolChoice};
use crate::error::{Error, Result};
use crate::money::{parse_decimal, Money, Unit, TOKENS_PER_MILLION};
use crate::wire::{DayOfWeek, Endpoint, Pricing, PricingOverride, Quantization, VideoModel};

/// Every price in its numeric form. Token prices are per token. `request`,
/// `image`, `image_output`, and `web_search` are per call or per image.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectivePrices {
    pub prompt: Decimal,
    pub completion: Decimal,
    pub input_cache_read: Option<Decimal>,
    pub input_cache_write: Option<Decimal>,
    pub input_cache_write_1h: Option<Decimal>,
    pub input_audio_cache: Option<Decimal>,
    pub audio: Option<Decimal>,
    pub audio_output: Option<Decimal>,
    pub request: Option<Decimal>,
    pub image: Option<Decimal>,
    pub image_output: Option<Decimal>,
    pub image_token: Option<Decimal>,
    pub web_search: Option<Decimal>,
    pub internal_reasoning: Option<Decimal>,
}

fn opt(raw: &Option<String>) -> Result<Option<Decimal>> {
    raw.as_deref().map(parse_decimal).transpose()
}

impl EffectivePrices {
    fn from_pricing(p: &Pricing) -> Result<Self> {
        Ok(Self {
            prompt: parse_decimal(&p.prompt)?,
            completion: parse_decimal(&p.completion)?,
            input_cache_read: opt(&p.input_cache_read)?,
            input_cache_write: opt(&p.input_cache_write)?,
            input_cache_write_1h: opt(&p.input_cache_write_1h)?,
            input_audio_cache: opt(&p.input_audio_cache)?,
            audio: opt(&p.audio)?,
            audio_output: opt(&p.audio_output)?,
            request: opt(&p.request)?,
            image: opt(&p.image)?,
            image_output: opt(&p.image_output)?,
            image_token: opt(&p.image_token)?,
            web_search: opt(&p.web_search)?,
            internal_reasoning: opt(&p.internal_reasoning)?,
        })
    }

    /// Replace only the fields the override sets.
    fn apply(&mut self, o: &PricingOverride) -> Result<()> {
        if let Some(v) = &o.prompt {
            self.prompt = parse_decimal(v)?;
        }
        if let Some(v) = &o.completion {
            self.completion = parse_decimal(v)?;
        }
        if let Some(v) = opt(&o.audio)? {
            self.audio = Some(v);
        }
        if let Some(v) = opt(&o.input_audio_cache)? {
            self.input_audio_cache = Some(v);
        }
        if let Some(v) = opt(&o.input_cache_read)? {
            self.input_cache_read = Some(v);
        }
        if let Some(v) = opt(&o.input_cache_write)? {
            self.input_cache_write = Some(v);
        }
        if let Some(v) = opt(&o.input_cache_write_1h)? {
            self.input_cache_write_1h = Some(v);
        }
        Ok(())
    }
}

/// Whether an override's conditions hold at `when` for a request with
/// `input_tokens` prompt tokens.
///
/// - `utc_start` and `utc_end` form a half-open HHMM window. The window may
///   wrap past midnight when `utc_start > utc_end`. An empty window never
///   matches. The window only applies when both bounds are set.
/// - `utc_days`, when non-empty, must include today's UTC weekday. It applies
///   with or without a window.
/// - `min_prompt_tokens` requires at least that many prompt tokens.
pub fn override_applies(o: &PricingOverride, when: DateTime<Utc>, input_tokens: u64) -> bool {
    if let (Some(start), Some(end)) = (o.utc_start, o.utc_end) {
        let hhmm = when.hour() * 100 + when.minute();
        let inside = if start <= end {
            start <= hhmm && hhmm < end
        } else {
            hhmm >= start || hhmm < end
        };
        if !inside {
            return false;
        }
    }
    if let Some(days) = &o.utc_days {
        if !days.is_empty() && !days.contains(&day_of_week(when.weekday())) {
            return false;
        }
    }
    if let Some(min) = o.min_prompt_tokens {
        if input_tokens < min {
            return false;
        }
    }
    true
}

fn day_of_week(w: Weekday) -> DayOfWeek {
    match w {
        Weekday::Mon => DayOfWeek::Monday,
        Weekday::Tue => DayOfWeek::Tuesday,
        Weekday::Wed => DayOfWeek::Wednesday,
        Weekday::Thu => DayOfWeek::Thursday,
        Weekday::Fri => DayOfWeek::Friday,
        Weekday::Sat => DayOfWeek::Saturday,
        Weekday::Sun => DayOfWeek::Sunday,
    }
}

impl Pricing {
    /// Prices in effect at `when` for a request with `input_tokens` prompt
    /// tokens. The first matching override applies.
    pub fn effective(&self, when: DateTime<Utc>, input_tokens: u64) -> Result<EffectivePrices> {
        let mut prices = EffectivePrices::from_pricing(self)?;
        if let Some(o) = self
            .overrides
            .iter()
            .find(|o| override_applies(o, when, input_tokens))
        {
            prices.apply(o)?;
        }
        Ok(prices)
    }

    /// Blended per-million-token rate: `share * prompt + (1 - share) * completion`.
    pub fn blended_per_million(&self, input_share: Ratio) -> Result<Money> {
        let prompt = parse_decimal(&self.prompt)?;
        let completion = parse_decimal(&self.completion)?;
        let share = input_share.to_decimal();
        let blended = share * prompt + (Decimal::ONE - share) * completion;
        Ok(Money::usd(
            blended * Decimal::from(TOKENS_PER_MILLION),
            Unit::PerMillionTokens,
        ))
    }
}

/// Measured usage for one request or an aggregate of requests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub requests: u64,
    pub images: u64,
    pub web_search_calls: u64,
}

/// Total USD cost of `usage` at the prices in effect at `when`.
pub fn cost_of(usage: &Usage, pricing: &Pricing, when: DateTime<Utc>) -> Result<Money> {
    let p = pricing.effective(when, usage.input_tokens)?;
    let tokens = |n: u64, price: Decimal| Decimal::from(n) * price;
    let total = tokens(usage.input_tokens, p.prompt)
        + tokens(usage.output_tokens, p.completion)
        + tokens(
            usage.cache_read_tokens,
            p.input_cache_read.unwrap_or(p.prompt),
        )
        + tokens(
            usage.cache_write_tokens,
            p.input_cache_write.unwrap_or(p.prompt),
        )
        + Decimal::from(usage.requests) * p.request.unwrap_or(Decimal::ZERO)
        + Decimal::from(usage.images) * p.image_output.unwrap_or(Decimal::ZERO)
        + Decimal::from(usage.web_search_calls) * p.web_search.unwrap_or(Decimal::ZERO);
    Ok(Money::usd(total, Unit::Total))
}

/// Filter applied to endpoints before ranking.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EndpointFilter {
    pub required_params: Vec<String>,
    pub min_uptime_30m: Option<Ratio>,
    pub tool_choice: Option<ToolChoice>,
    pub quantization: Option<Quantization>,
}

impl EndpointFilter {
    pub fn matches(&self, e: &Endpoint) -> Result<bool> {
        if !e.supports_all(&self.required_params) {
            return Ok(false);
        }
        if let Some(min) = self.min_uptime_30m {
            match e.uptime_30m()? {
                Some(u) if u.get() >= min.get() => {}
                _ => return Ok(false),
            }
        }
        if let Some(choice) = self.tool_choice {
            if !e.supports_tool_choice(choice) {
                return Ok(false);
            }
        }
        if let Some(q) = self.quantization {
            if !e.is_quantized_as(q) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Endpoints that pass `filter`, in input order.
pub fn filter<'a>(endpoints: &'a [Endpoint], filter: &EndpointFilter) -> Result<Vec<&'a Endpoint>> {
    let mut out = Vec::new();
    for e in endpoints {
        if filter.matches(e)? {
            out.push(e);
        }
    }
    Ok(out)
}

/// Endpoints that support every parameter in `required`.
pub fn supporting<'a>(endpoints: &'a [Endpoint], required: &[String]) -> Vec<&'a Endpoint> {
    endpoints
        .iter()
        .filter(|e| e.supports_all(required))
        .collect()
}

/// The endpoint with the lowest blended per-million rate among those that
/// pass `filter`. Ties keep the earlier endpoint.
pub fn cheapest<'a>(
    endpoints: &'a [Endpoint],
    filter_: &EndpointFilter,
    input_share: Ratio,
) -> Result<Option<&'a Endpoint>> {
    let mut best: Option<(&Endpoint, Decimal)> = None;
    for e in endpoints {
        if !filter_.matches(e)? {
            continue;
        }
        let price = e.pricing.blended_per_million(input_share)?.amount;
        match best {
            Some((_, current)) if current <= price => {}
            _ => best = Some((e, price)),
        }
    }
    Ok(best.map(|(e, _)| e))
}

/// Per-million price change from `a` to `b`. Positive means `b` is dearer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriceDelta {
    pub prompt: Money,
    pub completion: Money,
}

pub fn compare(a: &Pricing, b: &Pricing) -> Result<PriceDelta> {
    let delta = |from: &str, to: &str| -> Result<Money> {
        Money::usd(parse_decimal(to)? - parse_decimal(from)?, Unit::PerToken).to_per_million()
    };
    Ok(PriceDelta {
        prompt: delta(&a.prompt, &b.prompt)?,
        completion: delta(&a.completion, &b.completion)?,
    })
}

/// Endpoints keyed by provider slug (`tag`), sorted by slug.
pub fn group_by_provider(endpoints: &[Endpoint]) -> BTreeMap<&str, Vec<&Endpoint>> {
    let mut groups: BTreeMap<&str, Vec<&Endpoint>> = BTreeMap::new();
    for e in endpoints {
        groups.entry(e.tag.as_str()).or_default().push(e);
    }
    groups
}

/// Video SKUs whose key starts with this prefix are prices. Other keys are
/// quantities (durations, token counts, image counts) and are not prices.
const PRICE_SKU_PREFIX: &str = "cents_";

/// Unit implied by a price SKU key. `None` for keys the crate does not
/// recognize; those are left out of `VideoModel::prices`.
fn unit_for_sku(key: &str) -> Option<Unit> {
    if key.contains("per_image") || key.contains("image_input") {
        Some(Unit::PerImage)
    } else if key.contains("megapixel_second") {
        Some(Unit::PerMegapixelSecond)
    } else if key.contains("second") {
        Some(Unit::PerSecond)
    } else if key.contains("per_generation") || key.starts_with("cents_minimum") {
        Some(Unit::PerCall)
    } else {
        None
    }
}

impl VideoModel {
    /// Price SKUs as USD money with their unit. Unrecognized price keys are
    /// skipped rather than failing the whole model.
    pub fn prices(&self) -> Result<BTreeMap<String, Money>> {
        let mut out = BTreeMap::new();
        for (key, raw) in &self.pricing_skus {
            if !key.starts_with(PRICE_SKU_PREFIX) {
                continue;
            }
            if let Some(unit) = unit_for_sku(key) {
                out.insert(key.clone(), Money::from_cents(raw, unit)?);
            }
        }
        Ok(out)
    }

    /// Non-price SKUs, returned as raw strings.
    pub fn quantities(&self) -> BTreeMap<&str, &str> {
        self.pricing_skus
            .iter()
            .filter(|(k, _)| !k.starts_with(PRICE_SKU_PREFIX))
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }
}

/// Cost of `units` of one video price SKU, for example seconds of output.
pub fn video_cost(video: &VideoModel, sku: &str, units: u64) -> Result<Money> {
    let prices = video.prices()?;
    let price = prices
        .get(sku)
        .ok_or_else(|| Error::UnknownSku(sku.to_owned()))?;
    Ok(Money::usd(price.amount * Decimal::from(units), Unit::Total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        // 2026-10-05 is a Monday.
        Utc.with_ymd_and_hms(2026, 10, 5, h, m, 0).unwrap()
    }

    fn base_pricing() -> Pricing {
        Pricing {
            prompt: "0.000001".into(),
            completion: "0.000002".into(),
            ..Default::default()
        }
    }

    #[test]
    fn cost_uses_base_prices() {
        let usage = Usage {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            ..Default::default()
        };
        let cost = cost_of(&usage, &base_pricing(), at(12, 0)).unwrap();
        // 1M * $1/M + 0.5M * $2/M = $2
        assert_eq!(cost.amount, Decimal::from_str("2").unwrap());
    }

    #[test]
    fn window_applies_inside_and_not_outside() {
        let o = PricingOverride {
            utc_start: Some(100),
            utc_end: Some(400),
            prompt: Some("0.0000005".into()),
            ..Default::default()
        };
        assert!(override_applies(&o, at(2, 0), 0));
        assert!(!override_applies(&o, at(5, 0), 0));
        assert!(!override_applies(&o, at(0, 30), 0));
    }

    #[test]
    fn window_wraps_past_midnight() {
        let o = PricingOverride {
            utc_start: Some(2200),
            utc_end: Some(200),
            ..Default::default()
        };
        assert!(override_applies(&o, at(23, 0), 0));
        assert!(override_applies(&o, at(1, 0), 0));
        assert!(!override_applies(&o, at(12, 0), 0));
    }

    #[test]
    fn weekday_condition_is_enforced() {
        let weekend_only = PricingOverride {
            utc_days: Some(vec![DayOfWeek::Saturday, DayOfWeek::Sunday]),
            ..Default::default()
        };
        assert!(!override_applies(&weekend_only, at(12, 0), 0));
        let monday = PricingOverride {
            utc_days: Some(vec![DayOfWeek::Monday]),
            ..Default::default()
        };
        assert!(override_applies(&monday, at(12, 0), 0));
    }

    #[test]
    fn min_prompt_tokens_gates_the_override() {
        let o = PricingOverride {
            min_prompt_tokens: Some(200_000),
            prompt: Some("0.0000003".into()),
            ..Default::default()
        };
        assert!(!override_applies(&o, at(12, 0), 199_999));
        assert!(override_applies(&o, at(12, 0), 200_000));
    }

    #[test]
    fn matching_override_replaces_only_its_fields() {
        let mut p = base_pricing();
        p.overrides.push(PricingOverride {
            utc_start: Some(0),
            utc_end: Some(600),
            prompt: Some("0.0000005".into()),
            ..Default::default()
        });
        let eff = p.effective(at(3, 0), 0).unwrap();
        assert_eq!(eff.prompt, Decimal::from_str("0.0000005").unwrap());
        assert_eq!(eff.completion, Decimal::from_str("0.000002").unwrap());
    }

    #[test]
    fn cache_tokens_fall_back_to_prompt_rate() {
        let usage = Usage {
            cache_read_tokens: 1_000_000,
            ..Default::default()
        };
        let cost = cost_of(&usage, &base_pricing(), at(12, 0)).unwrap();
        assert_eq!(cost.amount, Decimal::from_str("1").unwrap());
    }

    #[test]
    fn per_call_prices_apply_to_counts() {
        let mut p = base_pricing();
        p.request = Some("0.01".into());
        p.web_search = Some("0.005".into());
        let usage = Usage {
            requests: 2,
            web_search_calls: 4,
            ..Default::default()
        };
        let cost = cost_of(&usage, &p, at(12, 0)).unwrap();
        assert_eq!(cost.amount, Decimal::from_str("0.04").unwrap());
    }

    #[test]
    fn blended_rate_weights_input_share() {
        let rate = base_pricing()
            .blended_per_million(Ratio::new(0.5).unwrap())
            .unwrap();
        // 0.5 * $1 + 0.5 * $2 = $1.5 per 1M
        assert_eq!(rate.amount, Decimal::from_str("1.5").unwrap());
    }

    #[test]
    fn compare_reports_per_million_delta() {
        let mut b = base_pricing();
        b.prompt = "0.000003".into();
        let d = compare(&base_pricing(), &b).unwrap();
        assert_eq!(d.prompt.amount, Decimal::from_str("2").unwrap());
        assert_eq!(d.completion.amount, Decimal::ZERO);
    }

    #[test]
    fn video_prices_come_only_from_cents_keys() {
        let video: VideoModel = serde_json::from_value(serde_json::json!({
            "id": "x/y", "canonical_slug": "x/y", "name": "Y", "description": "d",
            "created": 1,
            "pricing_skus": {
                "cents_per_second_output_720p": "3",
                "duration_seconds": "5",
                "cents_minimum_per_generation": "20"
            },
            "allowed_passthrough_parameters": []
        }))
        .unwrap();
        let prices = video.prices().unwrap();
        assert_eq!(prices.len(), 2);
        assert_eq!(video.quantities().get("duration_seconds"), Some(&"5"));
        let cost = video_cost(&video, "cents_per_second_output_720p", 10).unwrap();
        assert_eq!(cost.amount, Decimal::from_str("0.3").unwrap());
        assert!(matches!(
            video_cost(&video, "duration_seconds", 1),
            Err(Error::UnknownSku(_))
        ));
    }
}
