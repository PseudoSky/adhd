//! Money with an explicit unit. Arithmetic is exact (`rust_decimal`); floats
//! are never used for prices.

use std::fmt;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const TOKENS_PER_MILLION: i64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Currency {
    Usd,
}

/// What a `Money` amount is priced against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Unit {
    /// USD per single token (the wire format for token prices).
    PerToken,
    /// USD per one million tokens (the human-readable form).
    PerMillionTokens,
    /// USD per request or per web search call.
    PerCall,
    /// USD per generated image.
    PerImage,
    /// USD per second of video.
    PerSecond,
    /// USD per megapixel per second of video.
    PerMegapixelSecond,
    /// A computed total for a usage record.
    Total,
}

impl Unit {
    fn label(self) -> &'static str {
        match self {
            Unit::PerToken => "/token",
            Unit::PerMillionTokens => "/1M tokens",
            Unit::PerCall => "/call",
            Unit::PerImage => "/image",
            Unit::PerSecond => "/second",
            Unit::PerMegapixelSecond => "/megapixel-second",
            Unit::Total => "total",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Money {
    pub amount: Decimal,
    pub currency: Currency,
    pub unit: Unit,
}

impl Money {
    pub fn usd(amount: Decimal, unit: Unit) -> Self {
        Self {
            amount,
            currency: Currency::Usd,
            unit,
        }
    }

    pub fn zero(unit: Unit) -> Self {
        Self::usd(Decimal::ZERO, unit)
    }

    /// Parse a per-token price string such as `"0.0000025"`.
    pub fn per_token(raw: &str) -> Result<Self> {
        Ok(Self::usd(parse_decimal(raw)?, Unit::PerToken))
    }

    /// Parse a cents string such as `"14"` into USD with the given unit.
    pub fn from_cents(raw: &str, unit: Unit) -> Result<Self> {
        Ok(Self::usd(parse_decimal(raw)? / Decimal::from(100), unit))
    }

    pub fn checked_add(self, other: Self) -> Result<Self> {
        self.require_same(other)?;
        Ok(Self::usd(self.amount + other.amount, self.unit))
    }

    pub fn checked_sub(self, other: Self) -> Result<Self> {
        self.require_same(other)?;
        Ok(Self::usd(self.amount - other.amount, self.unit))
    }

    pub fn scale(self, factor: Decimal) -> Self {
        Self::usd(self.amount * factor, self.unit)
    }

    /// Convert a per-token price to per-million-tokens. Other units are
    /// rejected because they have no per-token meaning.
    pub fn to_per_million(self) -> Result<Self> {
        match self.unit {
            Unit::PerToken => Ok(Self::usd(
                self.amount * Decimal::from(TOKENS_PER_MILLION),
                Unit::PerMillionTokens,
            )),
            Unit::PerMillionTokens => Ok(self),
            _ => Err(Error::UnitMismatch(
                "only per-token prices convert to per-million",
            )),
        }
    }

    fn require_same(self, other: Self) -> Result<()> {
        if self.unit != other.unit || self.currency != other.currency {
            return Err(Error::UnitMismatch("unit or currency differs"));
        }
        Ok(())
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${}{}", self.amount.normalize(), self.unit.label())
    }
}

/// Parse an exact decimal, accepting exponent notation.
pub fn parse_decimal(raw: &str) -> Result<Decimal> {
    let trimmed = raw.trim();
    let parsed = if trimmed.contains(['e', 'E']) {
        Decimal::from_scientific(trimmed)
    } else {
        Decimal::from_str(trimmed)
    };
    parsed.map_err(|_| Error::InvalidDecimal(raw.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_token_converts_to_per_million_exactly() {
        let m = Money::per_token("0.0000025")
            .unwrap()
            .to_per_million()
            .unwrap();
        assert_eq!(m.amount, Decimal::from_str("2.5").unwrap());
        assert_eq!(m.unit, Unit::PerMillionTokens);
    }

    #[test]
    fn cents_become_usd() {
        let m = Money::from_cents("14", Unit::PerSecond).unwrap();
        assert_eq!(m.amount, Decimal::from_str("0.14").unwrap());
    }

    #[test]
    fn exponent_notation_parses() {
        assert_eq!(
            parse_decimal("1e-6").unwrap(),
            Decimal::from_str("0.000001").unwrap()
        );
    }

    #[test]
    fn invalid_decimal_is_an_error() {
        assert!(matches!(
            parse_decimal("abc"),
            Err(Error::InvalidDecimal(_))
        ));
    }

    #[test]
    fn mismatched_units_refuse_to_add() {
        let a = Money::usd(Decimal::ONE, Unit::PerCall);
        let b = Money::usd(Decimal::ONE, Unit::PerImage);
        assert!(a.checked_add(b).is_err());
    }
}
