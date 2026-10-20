//! Drives the real client against the live OpenRouter catalog. These endpoints
//! need no key and cost nothing, so they run by default. If the network is
//! unavailable, these tests fail loudly rather than skip.

use openrouter_pricing::{CatalogClient, ModelQuery, Sort};

#[tokio::test]
async fn lists_and_counts_models() {
    let client = CatalogClient::new().unwrap();
    let count = client.count_models().await.unwrap();
    assert!(count > 0);

    let page = client
        .list_models(&ModelQuery {
            limit: Some(5),
            sort: Some(Sort::PricingLowToHigh),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!page.items.is_empty());
    assert!(page.items.len() <= 5);
}

#[tokio::test]
async fn fetches_gpt4o_and_its_endpoints() {
    let client = CatalogClient::new().unwrap();
    let model = client.get_model("openai", "gpt-4o").await.unwrap();
    assert_eq!(model.id, "openai/gpt-4o");

    let with_endpoints = client
        .get_model_endpoints("openai", "gpt-4o")
        .await
        .unwrap();
    assert!(!with_endpoints.endpoints.is_empty());
}

#[tokio::test]
async fn lists_providers_and_auxiliary_catalogs() {
    let client = CatalogClient::new().unwrap();
    assert!(!client.list_providers().await.unwrap().is_empty());
    assert!(!client.list_embedding_models().await.unwrap().is_empty());
    assert!(!client.list_image_models().await.unwrap().is_empty());
    assert!(!client.list_video_models().await.unwrap().is_empty());
    assert!(!client.get_jwks().await.unwrap().is_empty());
}

#[tokio::test]
async fn zdr_endpoints_are_listed() {
    let client = CatalogClient::new().unwrap();
    assert!(!client.list_zdr_endpoints().await.unwrap().is_empty());
}
