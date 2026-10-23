//! Typed async client for the unauthenticated catalog endpoints.

use reqwest::Url;
use serde::de::DeserializeOwned;

use crate::error::{Error, Result};
use crate::query::ModelQuery;
use crate::wire::{
    Endpoint, EndpointListResponse, ImageModel, ImageModelListResponse, Jwk, JwksResponse, Model,
    ModelCountResponse, ModelEndpointsResponse, ModelListResponse, ModelResponse,
    ModelWithEndpoints, Provider, ProviderListResponse, VideoModel, VideoModelListResponse,
};

pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// One page of a list response.
#[derive(Debug, Clone, PartialEq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total_count: Option<u64>,
    pub next: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CatalogClient {
    http: reqwest::Client,
    base: Url,
}

impl CatalogClient {
    pub fn new() -> Result<Self> {
        Self::with_base_url(DEFAULT_BASE_URL)
    }

    pub fn with_base_url(base: &str) -> Result<Self> {
        let mut url = Url::parse(base).map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        if !url.path().ends_with('/') {
            let with_slash = format!("{}/", url.path());
            url.set_path(&with_slash);
        }
        let http = reqwest::Client::builder()
            .user_agent(concat!("openrouter-pricing/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { http, base: url })
    }

    /// Build a URL from path segments. Each segment is percent-encoded, so an
    /// author or slug can never change the path structure.
    fn url(&self, segments: &[&str]) -> Result<Url> {
        let mut url = self.base.clone();
        {
            let mut parts = url
                .path_segments_mut()
                .map_err(|()| Error::InvalidBaseUrl("base url cannot carry a path".into()))?;
            parts.pop_if_empty();
            parts.extend(segments);
        }
        Ok(url)
    }

    async fn get<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        query: &[(&str, String)],
    ) -> Result<T> {
        let url = self.url(segments)?;
        let response = self
            .http
            .get(url)
            .query(query)
            .send()
            .await?
            .error_for_status()?;
        Ok(response.json::<T>().await?)
    }

    /// `GET /models`
    pub async fn list_models(&self, query: &ModelQuery) -> Result<Page<Model>> {
        let r: ModelListResponse = self.get(&["models"], &query.to_query_pairs()).await?;
        Ok(Page {
            items: r.data,
            total_count: r.total_count,
            next: r.links.and_then(|l| l.next),
        })
    }

    /// `GET /models/count`
    pub async fn count_models(&self) -> Result<u64> {
        let r: ModelCountResponse = self.get(&["models", "count"], &[]).await?;
        Ok(r.data.count)
    }

    /// `GET /model/{author}/{slug}`
    pub async fn get_model(&self, author: &str, slug: &str) -> Result<Model> {
        let r: ModelResponse = self.get(&["model", author, slug], &[]).await?;
        Ok(r.data)
    }

    /// `GET /models/{author}/{slug}/endpoints`
    pub async fn get_model_endpoints(
        &self,
        author: &str,
        slug: &str,
    ) -> Result<ModelWithEndpoints> {
        let r: ModelEndpointsResponse = self
            .get(&["models", author, slug, "endpoints"], &[])
            .await?;
        Ok(r.data)
    }

    /// `GET /endpoints/zdr`
    pub async fn list_zdr_endpoints(&self) -> Result<Vec<Endpoint>> {
        let r: EndpointListResponse = self.get(&["endpoints", "zdr"], &[]).await?;
        Ok(r.data)
    }

    /// `GET /providers`
    pub async fn list_providers(&self) -> Result<Vec<Provider>> {
        let r: ProviderListResponse = self.get(&["providers"], &[]).await?;
        Ok(r.data)
    }

    /// `GET /embeddings/models`
    pub async fn list_embedding_models(&self) -> Result<Vec<Model>> {
        let r: ModelListResponse = self.get(&["embeddings", "models"], &[]).await?;
        Ok(r.data)
    }

    /// `GET /images/models`
    pub async fn list_image_models(&self) -> Result<Vec<ImageModel>> {
        let r: ImageModelListResponse = self.get(&["images", "models"], &[]).await?;
        Ok(r.data)
    }

    /// `GET /videos/models`
    pub async fn list_video_models(&self) -> Result<Vec<VideoModel>> {
        let r: VideoModelListResponse = self.get(&["videos", "models"], &[]).await?;
        Ok(r.data)
    }

    /// `GET /oauth/jwks`
    pub async fn get_jwks(&self) -> Result<Vec<Jwk>> {
        let r: JwksResponse = self.get(&["oauth", "jwks"], &[]).await?;
        Ok(r.keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_percent_encoded() {
        let c = CatalogClient::with_base_url(DEFAULT_BASE_URL).unwrap();
        let url = c.url(&["model", "a/b", "c?d"]).unwrap();
        assert_eq!(url.path(), "/api/v1/model/a%2Fb/c%3Fd");
    }

    #[test]
    fn base_url_gets_a_trailing_slash() {
        let c = CatalogClient::with_base_url("https://example.test/api/v1").unwrap();
        assert_eq!(c.url(&["models"]).unwrap().path(), "/api/v1/models");
    }
}
