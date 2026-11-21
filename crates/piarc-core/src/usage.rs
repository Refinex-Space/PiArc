//! Usage and cost (T41, FR-MD-06): Core's report of tokens and estimated cost by model and by
//! session, from the usage rows the index derives from session files (`piarc-store`).
//!
//! - **Prices.** The catalog's (pi-ai's `cost`, which Core records from every `models/list` it
//!   sees, `model_prices`) unless the user's `modelPrices` setting (user file only) names the
//!   model. A model with neither has no cost: reports leave it out of the sums and say so
//!   (`partial`), never count it as zero.
//! - **Arithmetic.** Rates become integers (picodollars per token: USD per million tokens
//!   × 10⁶); a request costs its tokens times the rates, summed exactly in `u128`, and only the
//!   final sums become floating-point dollars. The rules are `calculateCost`'s: the tier is the
//!   one with the largest `inputTokensAbove` below the request's input + cache reads + cache
//!   writes, and one-hour cache writes cost twice the input rate. Rates are linear, so models
//!   without tiers are priced on sums; tiered models are priced request by request.
//! - **Sessions.** A subagent's requests count in its main session (following
//!   `subagent_parent` to the top) and are listed under it; auxiliary calls (WebFetch's
//!   extraction, native web search, `prompt` hooks, Pi's cache warming) are listed by purpose.

use std::collections::{BTreeMap, HashMap};

use piarc_protocol::usage::{
    AuxiliaryUsage, ModelPrice, ModelUsage, PriceSource, PriceTier, SessionUsage, SubagentUsage,
    UsageReport, UsageTokens,
};
use piarc_store::{RequestTokens, UsageGroup, UsageSession};
use serde_json::Value;

/// Picodollars per token for one kind of token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Rates {
    input: u128,
    output: u128,
    cache_read: u128,
    cache_write: u128,
}

/// A rate in USD per million tokens as picodollars per token; `None` when it is not a
/// non-negative finite number.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "checked non-negative and finite; prices are far below u128::MAX"
)]
fn rate(usd_per_million: f64) -> Option<u128> {
    (usd_per_million.is_finite() && usd_per_million >= 0.0)
        .then(|| (usd_per_million * 1e6).round() as u128)
}

impl Rates {
    fn of(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Option<Self> {
        Some(Self {
            input: rate(input)?,
            output: rate(output)?,
            cache_read: rate(cache_read)?,
            cache_write: rate(cache_write)?,
        })
    }
}

/// A model's price as integer rates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pricing {
    base: Rates,
    /// `(inputTokensAbove, rates)`, in the catalog's order.
    tiers: Vec<(u64, Rates)>,
}

/// One request's (or a sum of requests') tokens as the arithmetic needs them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Part of `cache_write`.
    pub cache_write_1h: u64,
}

impl Pricing {
    /// The integer form of `price`; `None` when a rate is negative or not finite.
    #[must_use]
    pub fn of(price: &ModelPrice) -> Option<Self> {
        let base = Rates::of(
            price.input,
            price.output,
            price.cache_read,
            price.cache_write,
        )?;
        let tiers = price
            .tiers
            .iter()
            .map(|t| {
                Rates::of(t.input, t.output, t.cache_read, t.cache_write)
                    .map(|r| (t.input_tokens_above, r))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self { base, tiers })
    }

    /// Whether the price depends on a request's size.
    #[must_use]
    pub fn tiered(&self) -> bool {
        !self.tiers.is_empty()
    }

    /// The cost of one request in picodollars (`calculateCost`'s rules).
    #[must_use]
    pub fn request_pico(&self, t: Tokens) -> u128 {
        let size = t.input + t.cache_read + t.cache_write;
        let mut rates = self.base;
        let mut matched: Option<u64> = None;
        for (above, tier) in &self.tiers {
            if size > *above && matched.is_none_or(|m| *above > m) {
                rates = *tier;
                matched = Some(*above);
            }
        }
        Self::linear(rates, t)
    }

    /// The cost of summed requests in picodollars; only for prices without tiers.
    #[must_use]
    pub fn sum_pico(&self, t: Tokens) -> u128 {
        Self::linear(self.base, t)
    }

    fn linear(r: Rates, t: Tokens) -> u128 {
        let long = t.cache_write_1h.min(t.cache_write);
        let short = t.cache_write - long;
        u128::from(t.input) * r.input
            + u128::from(t.output) * r.output
            + u128::from(t.cache_read) * r.cache_read
            + u128::from(short) * r.cache_write
            + u128::from(long) * r.input * 2
    }
}

/// Picodollars as US dollars.
#[expect(
    clippy::cast_precision_loss,
    reason = "a display estimate: f64 keeps 15 significant digits"
)]
#[must_use]
pub fn dollars(pico: u128) -> f64 {
    pico as f64 / 1e12
}

/// The prices in effect: the user's, then the catalog's.
#[derive(Debug, Clone, Default)]
pub struct PriceBook {
    catalog: HashMap<(String, String), ModelPrice>,
    user: HashMap<(String, String), ModelPrice>,
}

/// Splits `provider/model` at the first `/` (model ids may contain more).
fn split_key(key: &str) -> Option<(String, String)> {
    let (provider, model) = key.split_once('/')?;
    (!provider.is_empty() && !model.is_empty()).then(|| (provider.to_owned(), model.to_owned()))
}

impl PriceBook {
    /// From the recorded catalog prices (`(provider, model, JSON)`) and the user's
    /// `modelPrices` object; malformed entries are left out.
    #[must_use]
    pub fn new(catalog: &[CatalogRow], user: Option<&Value>) -> Self {
        let catalog = catalog
            .iter()
            .filter_map(|(provider, model, json)| {
                let price = serde_json::from_str::<ModelPrice>(json).ok()?;
                Pricing::of(&price)?;
                Some(((provider.clone(), model.clone()), price))
            })
            .collect();
        let user = user
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| {
                let price = user_price(value)?;
                Some((split_key(key)?, price))
            })
            .collect();
        Self { catalog, user }
    }

    /// The price of `provider/model` and where it comes from.
    #[must_use]
    pub fn price(&self, provider: &str, model: &str) -> (Option<&ModelPrice>, PriceSource) {
        let key = (provider.to_owned(), model.to_owned());
        if let Some(price) = self.user.get(&key) {
            return (Some(price), PriceSource::User);
        }
        match self.catalog.get(&key) {
            Some(price) => (Some(price), PriceSource::Catalog),
            None => (None, PriceSource::Unknown),
        }
    }
}

/// A user's price entry (`{input, output, cacheRead, cacheWrite}`, no tiers).
#[must_use]
pub fn user_price(value: &Value) -> Option<ModelPrice> {
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    let price = ModelPrice {
        input: number("input")?,
        output: number("output")?,
        cache_read: number("cacheRead")?,
        cache_write: number("cacheWrite")?,
        tiers: Vec::new(),
    };
    Pricing::of(&price).map(|_| price)
}

/// A recorded catalog price: `(provider, model, pi-ai's cost as JSON)`.
pub type CatalogRow = (String, String, String);

/// A model: `(provider, model)`.
pub type ModelKey = (String, String);

/// The catalog prices of a `models/list` answer: rows for priced models, and the models it
/// lists without a price.
#[must_use]
pub fn catalog_prices(
    models: &[piarc_protocol::models::CatalogModel],
) -> (Vec<CatalogRow>, Vec<ModelKey>) {
    let mut priced = Vec::new();
    let mut unpriced = Vec::new();
    for model in models {
        match model
            .cost
            .as_ref()
            .and_then(|c| serde_json::to_string(c).ok())
        {
            Some(json) => priced.push((model.provider.clone(), model.id.clone(), json)),
            None => unpriced.push((model.provider.clone(), model.id.clone())),
        }
    }
    (priced, unpriced)
}

/// Tokens and cost so far; `None` cost once something has no price.
#[derive(Debug, Clone, Default)]
struct Sum {
    tokens: UsageTokens,
    pico: u128,
    unpriced: bool,
}

impl Sum {
    fn add(&mut self, tokens: &UsageTokens, pico: Option<u128>) {
        let t = &mut self.tokens;
        t.requests += tokens.requests;
        t.input += tokens.input;
        t.output += tokens.output;
        t.cache_read += tokens.cache_read;
        t.cache_write += tokens.cache_write;
        t.reasoning += tokens.reasoning;
        match pico {
            Some(p) => self.pico += p,
            None => self.unpriced = true,
        }
    }

    /// The cost of what had a price (`None` when nothing did and something did not).
    fn cost(&self) -> Option<f64> {
        (!self.unpriced || self.pico > 0).then(|| dollars(self.pico))
    }

    /// The cost only when everything had a price.
    fn full_cost(&self) -> Option<f64> {
        (!self.unpriced).then(|| dollars(self.pico))
    }
}

/// One priced piece of usage: a group, or one request of a tiered model.
struct Piece<'a> {
    session: &'a str,
    kind: &'a str,
    purpose: Option<&'a str>,
    provider: &'a str,
    model: &'a str,
    tokens: UsageTokens,
    pico: Option<u128>,
}

fn non_negative(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

fn arithmetic(t: &UsageTokens, cache_write_1h: i64) -> Tokens {
    Tokens {
        input: t.input,
        output: t.output,
        cache_read: t.cache_read,
        cache_write: t.cache_write,
        cache_write_1h: non_negative(cache_write_1h),
    }
}

/// What a report is built from.
pub struct Inputs<'a> {
    pub groups: &'a [UsageGroup],
    /// Requests of the tiered models, by `(provider, model)`.
    pub requests: &'a HashMap<ModelKey, Vec<RequestTokens>>,
    pub sessions: &'a [UsageSession],
    pub book: &'a PriceBook,
}

/// The main session `id` counts in: the top of its `subagent_parent` chain.
fn main_of<'a>(id: &'a str, parents: &HashMap<&'a str, &'a str>) -> &'a str {
    let mut current = id;
    // A chain is at most the subagent depth limit; the bound guards against a loop.
    for _ in 0..32 {
        match parents.get(current) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    current
}

/// The pieces of `inputs`, priced.
fn pieces<'a>(inputs: &Inputs<'a>) -> Vec<Piece<'a>> {
    let mut out = Vec::new();
    for g in inputs.groups {
        let (price, _) = inputs.book.price(&g.provider, &g.model);
        let pricing = price.and_then(Pricing::of);
        if pricing.as_ref().is_some_and(Pricing::tiered) {
            continue;
        }
        let tokens = UsageTokens {
            requests: non_negative(g.requests),
            input: non_negative(g.input),
            output: non_negative(g.output),
            cache_read: non_negative(g.cache_read),
            cache_write: non_negative(g.cache_write),
            reasoning: non_negative(g.reasoning),
        };
        let pico = pricing.map(|p| p.sum_pico(arithmetic(&tokens, g.cache_write_1h)));
        out.push(Piece {
            session: &g.session_id,
            kind: &g.kind,
            purpose: g.purpose.as_deref(),
            provider: &g.provider,
            model: &g.model,
            tokens,
            pico,
        });
    }
    for ((provider, model), requests) in inputs.requests {
        let (price, _) = inputs.book.price(provider, model);
        let Some(pricing) = price.and_then(Pricing::of).filter(Pricing::tiered) else {
            continue;
        };
        for r in requests {
            let tokens = UsageTokens {
                requests: 1,
                input: non_negative(r.input),
                output: non_negative(r.output),
                cache_read: non_negative(r.cache_read),
                cache_write: non_negative(r.cache_write),
                reasoning: non_negative(r.reasoning),
            };
            let pico = pricing.request_pico(arithmetic(&tokens, r.cache_write_1h));
            out.push(Piece {
                session: &r.session_id,
                kind: &r.kind,
                purpose: r.purpose.as_deref(),
                provider,
                model,
                tokens,
                pico: Some(pico),
            });
        }
    }
    out
}

#[derive(Default)]
struct SessionSums<'a> {
    total: Sum,
    models: BTreeMap<(&'a str, &'a str), Sum>,
    subagents: BTreeMap<&'a str, Sum>,
    auxiliary: BTreeMap<&'a str, Sum>,
}

fn model_rows(book: &PriceBook, sums: &BTreeMap<(&str, &str), Sum>) -> Vec<ModelUsage> {
    sums.iter()
        .map(|((provider, model), sum)| {
            let (price, source) = book.price(provider, model);
            ModelUsage {
                provider: (*provider).to_owned(),
                model: (*model).to_owned(),
                tokens: sum.tokens.clone(),
                cost: sum.full_cost(),
                price_source: source,
                price: price.cloned(),
            }
        })
        .collect()
}

/// A main session's row of the report.
fn session_row(
    info: &UsageSession,
    sums: &SessionSums<'_>,
    by_id: &HashMap<&str, &UsageSession>,
    book: &PriceBook,
) -> SessionUsage {
    SessionUsage {
        session_id: info.id.clone(),
        title: info.title.clone(),
        workspace: info.workspace.clone(),
        tokens: sums.total.tokens.clone(),
        cost: sums.total.cost(),
        partial: sums.total.unpriced,
        models: model_rows(book, &sums.models),
        subagents: sums
            .subagents
            .iter()
            .map(|(id, sum)| SubagentUsage {
                session_id: (*id).to_owned(),
                agent_type: by_id.get(id).and_then(|s| s.subagent_type.clone()),
                tokens: sum.tokens.clone(),
                cost: sum.cost(),
            })
            .collect(),
        auxiliary: sums
            .auxiliary
            .iter()
            .map(|(purpose, sum)| AuxiliaryUsage {
                purpose: (*purpose).to_owned(),
                tokens: sum.tokens.clone(),
                cost: sum.cost(),
            })
            .collect(),
    }
}

/// The report: by model, and by main session (only those `keep` accepts) with their subagents
/// and auxiliary calls; sessions in `inputs.sessions` order.
#[must_use]
pub fn report(inputs: &Inputs<'_>, keep: &dyn Fn(&UsageSession) -> bool) -> UsageReport {
    let by_id: HashMap<&str, &UsageSession> =
        inputs.sessions.iter().map(|s| (s.id.as_str(), s)).collect();
    let parents: HashMap<&str, &str> = inputs
        .sessions
        .iter()
        .filter_map(|s| Some((s.id.as_str(), s.subagent_parent.as_deref()?)))
        .collect();
    let mut total = Sum::default();
    let mut models: BTreeMap<(&str, &str), Sum> = BTreeMap::new();
    let mut sessions: HashMap<&str, SessionSums<'_>> = HashMap::new();
    for piece in pieces(inputs) {
        let main = main_of(piece.session, &parents);
        let Some(info) = by_id.get(main) else {
            continue;
        };
        if !keep(info) {
            continue;
        }
        total.add(&piece.tokens, piece.pico);
        models
            .entry((piece.provider, piece.model))
            .or_default()
            .add(&piece.tokens, piece.pico);
        let s = sessions.entry(main).or_default();
        s.total.add(&piece.tokens, piece.pico);
        s.models
            .entry((piece.provider, piece.model))
            .or_default()
            .add(&piece.tokens, piece.pico);
        if piece.session != main {
            s.subagents
                .entry(piece.session)
                .or_default()
                .add(&piece.tokens, piece.pico);
        }
        if piece.kind == "auxiliary" {
            s.auxiliary
                .entry(piece.purpose.unwrap_or("other"))
                .or_default()
                .add(&piece.tokens, piece.pico);
        }
    }
    let sessions = inputs
        .sessions
        .iter()
        .filter_map(|info| {
            let sums = sessions.get(info.id.as_str())?;
            Some(session_row(info, sums, &by_id, inputs.book))
        })
        .collect();
    UsageReport {
        tokens: total.tokens.clone(),
        cost: total.cost(),
        partial: total.unpriced,
        models: model_rows(inputs.book, &models),
        sessions,
    }
}

/// Every `(provider, model)` of `groups` whose price in `book` has tiers.
#[must_use]
pub fn tiered_models(groups: &[UsageGroup], book: &PriceBook) -> Vec<ModelKey> {
    let mut out: Vec<ModelKey> = groups
        .iter()
        .filter(|g| {
            book.price(&g.provider, &g.model)
                .0
                .and_then(Pricing::of)
                .is_some_and(|p| p.tiered())
        })
        .map(|g| (g.provider.clone(), g.model.clone()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A tier for tests and callers building prices by hand.
#[must_use]
pub fn tier(above: u64, input: f64, output: f64, cache_read: f64, cache_write: f64) -> PriceTier {
    PriceTier {
        input_tokens_above: above,
        input,
        output,
        cache_read,
        cache_write,
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
