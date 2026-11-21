//! One run's environment: the temporary directories, one strict mock per endpoint and the
//! Pi provider entries that point at them, the gate, the vault's key and Core's
//! configuration (moved out of `runner.rs`, R4 I150).

use super::*;

/// The directories, mocks and Pi configuration of one run.
pub(super) struct Env {
    pub(super) workspace: PathBuf,
    pub(super) data: PathBuf,
    pub(super) cache: PathBuf,
    pub(super) home: PathBuf,
    pub(super) mocks: BTreeMap<String, MockProvider>,
    pub(super) gate: Arc<Gate>,
    /// Kept across Core restarts, so a restarted Core finds its vault's master key.
    pub(super) key_store: Arc<MemorySecretStore>,
    pub(super) master_key: piarc_ports::SecretName,
    pub(super) config: RunnerConfig,
    /// What commands start from (see [`command_env`]).
    pub(super) command_env: piarc_core::tool_io::CommandEnv,
    /// The scenario's web server (T29), which Core's WebFetch may reach.
    pub(super) web: Option<crate::l2::web::WebServer>,
    /// The mock authorization server and the test provider's file (T29).
    pub(super) auth: Option<crate::auth_server::MockAuthServer>,
    pub(super) oauth_file: Option<PathBuf>,
    /// The HTTP MCP fixture servers by name (T36).
    pub(super) mcp_http: BTreeMap<String, crate::mcp_server::MockMcpServer>,
    /// The task manager's clock (T32), kept across Core restarts; `advance_clock` moves it.
    pub(super) clock: Arc<piarc_core::clock::ManualClock>,
    /// The scenario's Monitor limits (T32).
    pub(super) task_limits: Option<crate::l2::format::TaskLimitsSpec>,
}

impl Env {
    pub(super) async fn prepare(
        spec: &ScenarioSpec,
        config: &RunnerConfig,
        root: &Path,
        mode: Mode,
    ) -> Result<Self, String> {
        let workspace = root.join("work space 工作区");
        let data = root.join("data 数据");
        let cache = root.join("cache");
        for dir in [&workspace, &data.join("pi"), &cache] {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mcp_http = mcp::start_servers(spec).await?;
        let urls = mcp_http.iter().map(|(n, s)| (n.clone(), s.url())).collect();
        prepare_workspace(spec, root, &workspace, &urls)?;
        let web = match &spec.web {
            Some(pages) => Some(
                crate::l2::web::start(pages)
                    .await
                    .map_err(|e| format!("web server: {e}"))?,
            ),
            None => None,
        };
        let mut mocks = BTreeMap::new();
        let mut providers = serde_json::Map::new();
        for (name, endpoint) in &spec.providers {
            let id = spec.mock_scenario_id(name);
            let mut script = endpoint.script();
            for call in script
                .steps
                .iter_mut()
                .flat_map(|s| s.tool_calls.iter_mut())
            {
                if let Some(web) = &web {
                    crate::l2::web::fill_value(&mut call.input, web.port);
                }
                fill_workspace(&mut call.input, &workspace);
            }
            let library = Scenario::new(&id, script)
                .and_then(|scenario| ScenarioLibrary::new().with(scenario))
                .map_err(|e| e.to_string())?;
            let mock = MockProvider::start_with(library, 0, mode)
                .await
                .map_err(|e| format!("mock `{name}`: {e}"))?;
            if endpoint.configure_as.is_none() {
                providers.insert(pi_provider(name), pi_provider_entry(&mock, endpoint, &id));
            }
            mocks.insert(name.clone(), mock);
        }
        let pi = data.join("pi");
        write_json(&pi.join("models.json"), &json!({ "providers": providers }))?;
        // Retries wait milliseconds, not seconds.
        write_json(
            &pi.join("settings.json"),
            &json!({ "retry": { "baseDelayMs": 5 } }),
        )?;
        let (auth, oauth_file) = login::oauth_setup(spec, &mocks, root).await?;
        let gate = Arc::new(Gate::new(spec.expect.tool_batches.clone()));
        let home = root.join("home 家");
        let command_env = command_env(&home)?;
        Ok(Self {
            workspace,
            data,
            cache,
            home,
            mocks,
            gate,
            key_store: Arc::new(MemorySecretStore::new()),
            master_key: test_master_key_name("l2"),
            config: config.clone(),
            command_env,
            web,
            auth,
            oauth_file,
            mcp_http,
            clock: piarc_core::clock::ManualClock::new(),
            task_limits: spec.task_limits,
        })
    }

    pub(super) fn core_config(&self) -> CoreConfig {
        let dirs = DataDirs::new(self.data.clone(), self.cache.clone()).ok();
        CoreConfig {
            dirs,
            home: Some(self.home.clone()),
            sessions: SessionsConfig {
                launch: Some(AgentHostLaunch::Custom {
                    node: self.config.node.clone(),
                    bundle: self.config.bundle.clone(),
                    pi_package_dir: Some(self.config.pi_assets.clone()),
                    extra_args: self
                        .oauth_file
                        .iter()
                        .flat_map(|f| ["--test-oauth-provider".into(), f.clone().into_os_string()])
                        .collect(),
                    extra_env: vec![("PI_OFFLINE".into(), "1".into())],
                }),
                ..SessionsConfig::default()
            },
            secret_store: Some(SecretStoreSetup {
                master_key: self.master_key.clone(),
                store: Arc::clone(&self.key_store) as _,
            }),
            tool_observer: Some(Arc::clone(&self.gate) as _),
            command_env: Some(self.command_env.clone()),
            tasks: piarc_core::tasks::TasksConfig {
                clock: self.clock.clone(),
                limits: self
                    .task_limits
                    .map_or_else(Default::default, |spec| spec.apply(Default::default())),
            },
            worktrees: worktrees::config(&self.clock),
            web: piarc_core::tool_io::WebConfig {
                allowlist: if self.web.is_some() {
                    vec!["127.0.0.1".into(), "localhost".into()]
                } else {
                    Vec::new()
                },
                // The scenario's web server answers Brave Search's path (T38).
                search_endpoints: self
                    .web
                    .as_ref()
                    .map(|web| {
                        [(
                            "brave".to_owned(),
                            format!("http://127.0.0.1:{}/res/v1/web/search", web.port),
                        )]
                        .into()
                    })
                    .unwrap_or_default(),
                ..piarc_core::tool_io::WebConfig::default()
            },
            ..CoreConfig::default()
        }
    }

    /// Starts Core; every Core of the run delivers to the same `events`.
    pub(super) fn start_core(&self, events: &Arc<Events>) -> Result<CoreRuntime, String> {
        CoreRuntime::start(self.core_config(), Arc::new(Sink(Arc::clone(events))))
            .map_err(|e| format!("Core did not start: {e}"))
    }

    pub(super) fn records(&self) -> BTreeMap<String, Vec<RequestRecord>> {
        self.mocks
            .iter()
            .map(|(name, mock)| (name.clone(), mock.records()))
            .collect()
    }
}

/// Replaces `{{workspace}}` in the strings of `value` with the workspace's absolute path.
pub(super) fn fill_workspace(value: &mut Value, workspace: &Path) {
    match value {
        Value::String(s) if s.contains(WORKSPACE_PLACEHOLDER) => {
            *s = s.replace(WORKSPACE_PLACEHOLDER, &workspace.to_string_lossy());
        }
        Value::Array(items) => items.iter_mut().for_each(|v| fill_workspace(v, workspace)),
        Value::Object(map) => map.values_mut().for_each(|v| fill_workspace(v, workspace)),
        _ => {}
    }
}

/// Stands for the workspace's absolute path in the tool arguments of an endpoint's script.
pub const WORKSPACE_PLACEHOLDER: &str = "{{workspace}}";

/// The Pi provider id of endpoint `name`.
pub(super) fn pi_provider(name: &str) -> String {
    format!("mock-{name}")
}

pub(super) fn pi_provider_entry(
    mock: &MockProvider,
    endpoint: &ProviderSpec,
    scenario: &str,
) -> Value {
    let (base_url, api) = match endpoint.wire {
        Wire::Anthropic => (mock.anthropic_base_url(), "anthropic-messages"),
        Wire::Openai => (mock.openai_base_url(), "openai-completions"),
    };
    // Header selection keeps the prompts free of scenario markers.
    let mut headers = serde_json::Map::new();
    headers.insert(crate::server::SCENARIO_HEADER.to_owned(), json!(scenario));
    let input = if endpoint.vision {
        json!(["text", "image"])
    } else {
        json!(["text"])
    };
    let reasoning = endpoint.reasoning;
    json!({
        "baseUrl": base_url, "api": api, "apiKey": "piarc-no-key",
        "models": [{
            "id": endpoint.model_id(), "name": endpoint.model_id(), "reasoning": reasoning, "input": input,
            "compat": if reasoning && endpoint.wire == Wire::Openai {json!({"supportsReasoningEffort":true})} else {json!({})},
            "contextWindow": endpoint.context_window.unwrap_or(200_000),
            "maxTokens": endpoint.max_tokens.unwrap_or(4096),
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "headers": headers
        }]
    })
}
