//! T41-A10, A11: costs equal pi-ai's `calculateCost` for catalog prices (shared vectors in
//! `tests/usage/cost-vectors.json`), sums are exact, subagents count in their main session and
//! are listed, user prices replace the catalog's, unknown prices are unknown rather than zero.
use super::*;
use serde_json::json;

fn vectors() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/usage/cost-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("JSON")
}

fn count(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

#[test]
fn request_costs_match_calculate_cost() {
    let doc = vectors();
    let list = doc["vectors"].as_array().expect("vectors");
    assert!(list.len() >= 20);
    for v in list {
        let price: ModelPrice =
            serde_json::from_value(doc["prices"][v["price"].as_str().expect("name")].clone())
                .expect("price");
        let pricing = Pricing::of(&price).expect("pricing");
        let u = &v["usage"];
        let tokens = Tokens {
            input: count(u, "input"),
            output: count(u, "output"),
            cache_read: count(u, "cacheRead"),
            cache_write: count(u, "cacheWrite"),
            cache_write_1h: count(u, "cacheWrite1h"),
        };
        let ours = dollars(pricing.request_pico(tokens));
        let theirs = v["total"].as_f64().expect("total");
        let tolerance = theirs.abs().max(1e-9) * 1e-12;
        assert!(
            (ours - theirs).abs() <= tolerance,
            "{} {u}: {ours} vs calculateCost {theirs}",
            v["price"]
        );
    }
}

fn group(session: &str, kind: &str, purpose: Option<&str>, model: &str, input: i64) -> UsageGroup {
    UsageGroup {
        session_id: session.into(),
        kind: kind.into(),
        purpose: purpose.map(Into::into),
        provider: "p".into(),
        model: model.into(),
        requests: 1,
        input,
        output: 10,
        cache_read: 100,
        cache_write: 20,
        cache_write_1h: 0,
        reasoning: 0,
    }
}

fn session(id: &str, parent: Option<&str>) -> UsageSession {
    UsageSession {
        id: id.into(),
        title: Some(id.into()),
        workspace: Some("/w".into()),
        subagent_parent: parent.map(Into::into),
        subagent_type: parent.map(|_| "Explore".into()),
        updated_at: None,
    }
}

const PLAIN: &str = r#"{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}"#;

#[test]
fn sessions_sum_their_subagents_and_auxiliary_calls_and_unknown_prices_stay_unknown() {
    let groups = vec![
        group("main", "model", None, "a", 1000),
        group("main", "auxiliary", Some("webFetch"), "a", 50),
        group("child", "model", None, "a", 300),
        group("main", "model", None, "free", 7),
    ];
    let sessions = vec![session("main", None), session("child", Some("main"))];
    let book = PriceBook::new(&[("p".into(), "a".into(), PLAIN.into())], None);
    let requests = HashMap::new();
    let inputs = Inputs {
        groups: &groups,
        requests: &requests,
        sessions: &sessions,
        book: &book,
    };
    let first = report(&inputs, &|_| true);
    assert_eq!(
        first.sessions.len(),
        1,
        "the subagent is under its main session"
    );
    let main = &first.sessions[0];
    assert_eq!(main.tokens.requests, 4);
    assert_eq!(main.tokens.input, 1357);
    // Each priced group: input × 3 + 10 × 15 + 100 × 0.3 + 20 × 3.75 (USD per million).
    let priced = |input: f64| (input * 3.0 + 150.0 + 30.0 + 75.0) / 1e6;
    let expected = priced(1000.0) + priced(50.0) + priced(300.0);
    assert!((main.cost.expect("cost") - expected).abs() < 1e-15);
    assert!(main.partial, "the free model has no price");
    let unknown = main
        .models
        .iter()
        .find(|m| m.model == "free")
        .expect("free model");
    assert_eq!(
        (unknown.cost, unknown.price_source),
        (None, PriceSource::Unknown)
    );
    assert_eq!(main.subagents.len(), 1);
    assert_eq!(main.subagents[0].agent_type.as_deref(), Some("Explore"));
    assert!((main.subagents[0].cost.expect("cost") - priced(300.0)).abs() < 1e-15);
    assert_eq!(main.auxiliary[0].purpose, "webFetch");
    assert_eq!(first.models.len(), 2);
    assert!(first.partial);

    // The user's price replaces the catalog's; a price for the free model makes it known.
    let user = json!({
        "p/a": {"input": 1, "output": 1, "cacheRead": 1, "cacheWrite": 1},
        "p/free": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    });
    let book = PriceBook::new(&[("p".into(), "a".into(), PLAIN.into())], Some(&user));
    let inputs = Inputs {
        book: &book,
        ..inputs
    };
    let second = report(&inputs, &|_| true);
    let main = &second.sessions[0];
    assert!(!main.partial);
    let a = main.models.iter().find(|m| m.model == "a").expect("a");
    assert_eq!(a.price_source, PriceSource::User);
    // Three groups at 1 USD per million each: (1000 + 50 + 300) input + 3 × (10 + 100 + 20).
    assert!((a.cost.expect("cost") - 1740.0 / 1e6).abs() < 1e-15);
    assert_eq!(
        main.models
            .iter()
            .find(|m| m.model == "free")
            .and_then(|m| m.cost),
        Some(0.0)
    );
}

#[test]
fn tiered_models_are_priced_request_by_request() {
    let tiered = r#"{"input":1,"output":1,"cacheRead":1,"cacheWrite":1,"tiers":[{"inputTokensAbove":100,"input":10,"output":10,"cacheRead":10,"cacheWrite":10}]}"#;
    let book = PriceBook::new(&[("p".into(), "t".into(), tiered.into())], None);
    let groups = vec![UsageGroup {
        requests: 2,
        input: 150,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        ..group("main", "model", None, "t", 0)
    }];
    assert_eq!(
        tiered_models(&groups, &book),
        [("p".to_owned(), "t".to_owned())]
    );
    let small = RequestTokens {
        session_id: "main".into(),
        kind: "model".into(),
        purpose: None,
        input: 50,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cache_write_1h: 0,
        reasoning: 0,
    };
    let large = RequestTokens {
        input: 101,
        ..small.clone()
    };
    let mut requests = HashMap::new();
    requests.insert(("p".to_owned(), "t".to_owned()), vec![small, large]);
    let sessions = vec![session("main", None)];
    let tiered_report = report(
        &Inputs {
            groups: &groups,
            requests: &requests,
            sessions: &sessions,
            book: &book,
        },
        &|_| true,
    );
    // 50 at the base rate, 101 above the tier: not 151 at either rate.
    let expected = (50.0 * 1.0 + 101.0 * 10.0) / 1e6;
    assert!((tiered_report.cost.expect("cost") - expected).abs() < 1e-15);
    assert_eq!(tiered_report.tokens.requests, 2);
}

#[test]
fn malformed_and_negative_prices_are_ignored() {
    let user =
        json!({"p/a": {"input": -1, "output": 1, "cacheRead": 1, "cacheWrite": 1}, "nokey": {}});
    let book = PriceBook::new(&[("p".into(), "b".into(), "not json".into())], Some(&user));
    assert_eq!(book.price("p", "a").1, PriceSource::Unknown);
    assert_eq!(book.price("p", "b").1, PriceSource::Unknown);
    assert!(user_price(&json!({"input": 1})).is_none());
}
