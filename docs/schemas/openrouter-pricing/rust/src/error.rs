//! Crate-wide error type.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid decimal price {0:?}")]
    InvalidDecimal(String),

    #[error("invalid model id {0:?}, expected \"author/slug\"")]
    InvalidModelId(String),

    #[error("ratio {0} is outside [0, 1]")]
    InvalidRatio(f64),

    #[error("cannot combine or convert money: {0}")]
    UnitMismatch(&'static str),

    #[error("no price SKU {0:?} on this video model")]
    UnknownSku(String),

    #[error("invalid base url: {0}")]
    InvalidBaseUrl(String),

    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
