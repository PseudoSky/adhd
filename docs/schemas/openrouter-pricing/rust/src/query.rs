//! Query parameters for `GET /models`. Every filter the endpoint accepts is
//! typed here, and `to_query_pairs` produces the wire form.

use rust_decimal::Decimal;

use crate::domain::Ratio;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    MostPopular,
    Newest,
    TopWeekly,
    PricingLowToHigh,
    PricingHighToLow,
    ContextHighToLow,
    ThroughputHighToLow,
    LatencyLowToHigh,
    IntelligenceHighToLow,
    CodingHighToLow,
    AgenticHighToLow,
    DesignArenaEloHighToLow,
}

impl Sort {
    pub fn as_str(self) -> &'static str {
        match self {
            Sort::MostPopular => "most-popular",
            Sort::Newest => "newest",
            Sort::TopWeekly => "top-weekly",
            Sort::PricingLowToHigh => "pricing-low-to-high",
            Sort::PricingHighToLow => "pricing-high-to-low",
            Sort::ContextHighToLow => "context-high-to-low",
            Sort::ThroughputHighToLow => "throughput-high-to-low",
            Sort::LatencyLowToHigh => "latency-low-to-high",
            Sort::IntelligenceHighToLow => "intelligence-high-to-low",
            Sort::CodingHighToLow => "coding-high-to-low",
            Sort::AgenticHighToLow => "agentic-high-to-low",
            Sort::DesignArenaEloHighToLow => "design-arena-elo-high-to-low",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Programming,
    Roleplay,
    Marketing,
    MarketingSeo,
    Technology,
    Science,
    Translation,
    Legal,
    Finance,
    Health,
    Trivia,
    Academia,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Programming => "programming",
            Category::Roleplay => "roleplay",
            Category::Marketing => "marketing",
            Category::MarketingSeo => "marketing/seo",
            Category::Technology => "technology",
            Category::Science => "science",
            Category::Translation => "translation",
            Category::Legal => "legal",
            Category::Finance => "finance",
            Category::Health => "health",
            Category::Trivia => "trivia",
            Category::Academia => "academia",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    Eu,
    Us,
}

impl Region {
    pub fn as_str(self) -> &'static str {
        match self {
            Region::Eu => "eu",
            Region::Us => "us",
        }
    }
}

/// Filters for `GET /models`. Unset fields are omitted from the request.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelQuery {
    pub offset: Option<u64>,
    pub limit: Option<u32>,
    pub category: Option<Category>,
    pub supported_parameters: Vec<String>,
    pub output_modalities: Vec<String>,
    pub sort: Option<Sort>,
    pub q: Option<String>,
    pub input_modalities: Vec<String>,
    pub context: Option<u64>,
    pub min_price: Option<Decimal>,
    pub max_price: Option<Decimal>,
    pub min_output_price: Option<Decimal>,
    pub max_output_price: Option<Decimal>,
    pub arch: Option<String>,
    pub model_authors: Vec<String>,
    pub providers: Vec<String>,
    pub distillable: Option<bool>,
    /// Only models with zero-data-retention endpoints. The API accepts only "true".
    pub zdr: bool,
    pub region: Option<Region>,
    pub min_age_days: Option<u64>,
    pub max_age_days: Option<u64>,
    pub min_intelligence_index: Option<f64>,
    pub max_intelligence_index: Option<f64>,
    pub min_coding_index: Option<f64>,
    pub max_coding_index: Option<f64>,
    pub min_agentic_index: Option<f64>,
    pub max_agentic_index: Option<f64>,
    pub min_tool_success_rate: Option<Ratio>,
    pub max_tool_success_rate: Option<Ratio>,
}

impl ModelQuery {
    pub fn to_query_pairs(&self) -> Vec<(&'static str, String)> {
        let mut p: Vec<(&'static str, String)> = Vec::new();
        push(&mut p, "offset", self.offset);
        push(&mut p, "limit", self.limit);
        if let Some(c) = self.category {
            p.push(("category", c.as_str().to_owned()));
        }
        join(&mut p, "supported_parameters", &self.supported_parameters);
        join(&mut p, "output_modalities", &self.output_modalities);
        if let Some(s) = self.sort {
            p.push(("sort", s.as_str().to_owned()));
        }
        push(&mut p, "q", self.q.as_ref());
        join(&mut p, "input_modalities", &self.input_modalities);
        push(&mut p, "context", self.context);
        push(&mut p, "min_price", self.min_price);
        push(&mut p, "max_price", self.max_price);
        push(&mut p, "min_output_price", self.min_output_price);
        push(&mut p, "max_output_price", self.max_output_price);
        push(&mut p, "arch", self.arch.as_ref());
        join(&mut p, "model_authors", &self.model_authors);
        join(&mut p, "providers", &self.providers);
        if let Some(d) = self.distillable {
            p.push(("distillable", d.to_string()));
        }
        if self.zdr {
            p.push(("zdr", "true".to_owned()));
        }
        if let Some(r) = self.region {
            p.push(("region", r.as_str().to_owned()));
        }
        push(&mut p, "min_age_days", self.min_age_days);
        push(&mut p, "max_age_days", self.max_age_days);
        push(
            &mut p,
            "min_intelligence_index",
            self.min_intelligence_index,
        );
        push(
            &mut p,
            "max_intelligence_index",
            self.max_intelligence_index,
        );
        push(&mut p, "min_coding_index", self.min_coding_index);
        push(&mut p, "max_coding_index", self.max_coding_index);
        push(&mut p, "min_agentic_index", self.min_agentic_index);
        push(&mut p, "max_agentic_index", self.max_agentic_index);
        push(
            &mut p,
            "min_tool_success_rate",
            self.min_tool_success_rate.map(|r| r.get()),
        );
        push(
            &mut p,
            "max_tool_success_rate",
            self.max_tool_success_rate.map(|r| r.get()),
        );
        p
    }
}

fn push<T: ToString>(out: &mut Vec<(&'static str, String)>, key: &'static str, value: Option<T>) {
    if let Some(v) = value {
        out.push((key, v.to_string()));
    }
}

fn join(out: &mut Vec<(&'static str, String)>, key: &'static str, values: &[String]) {
    if !values.is_empty() {
        out.push((key, values.join(",")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn empty_query_sends_nothing() {
        assert!(ModelQuery::default().to_query_pairs().is_empty());
    }

    #[test]
    fn filters_serialize_to_wire_names() {
        let q = ModelQuery {
            sort: Some(Sort::PricingLowToHigh),
            category: Some(Category::MarketingSeo),
            region: Some(Region::Eu),
            zdr: true,
            max_price: Some(Decimal::from_str("10").unwrap()),
            input_modalities: vec!["text".into(), "image".into()],
            ..Default::default()
        };
        let pairs = q.to_query_pairs();
        assert!(pairs.contains(&("sort", "pricing-low-to-high".into())));
        assert!(pairs.contains(&("category", "marketing/seo".into())));
        assert!(pairs.contains(&("region", "eu".into())));
        assert!(pairs.contains(&("zdr", "true".into())));
        assert!(pairs.contains(&("max_price", "10".into())));
        assert!(pairs.contains(&("input_modalities", "text,image".into())));
    }
}
