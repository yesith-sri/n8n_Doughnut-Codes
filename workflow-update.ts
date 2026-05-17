import {
  workflow,
  node,
  trigger,
  ifElse,
  switchCase,
  merge,
  expr,
  newCredential,
  languageModel,
} from "@n8n/workflow-sdk";

// ── Shared OpenAI model ──
const openAiGpt41 = languageModel({
  type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  version: 1.3,
  config: {
    name: "OpenAI GPT-4.1",
    parameters: {
      model: {
        __rl: true,
        value: "gpt-4.1",
        mode: "list",
        cachedResultName: "gpt-4.1",
      },
      options: {},
    },
    position: [976, 576],
  },
});

// ═══════════════════════════════════════════════════════════
//  TRIGGERS
// ═══════════════════════════════════════════════════════════

const deploymentWebhook = trigger({
  type: "n8n-nodes-base.webhook",
  version: 2.1,
  config: {
    name: "Deployment Webhook",
    position: [0, 464],
    parameters: {
      httpMethod: "POST",
      path: "deploy",
      responseMode: "responseNode",
      options: { allowedOrigins: "*" },
    },
  },
  output: [{ body: { dockerImageUrl: "nginx:latest" } }],
});

const monitoringSchedule = trigger({
  type: "n8n-nodes-base.scheduleTrigger",
  version: 1.3,
  config: {
    name: "Monitoring Schedule",
    position: [0, 848],
    parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } },
  },
  output: [{}],
});

// ═══════════════════════════════════════════════════════════
//  MAIN PIPELINE (INBOUND)
// ═══════════════════════════════════════════════════════════

const normalizeInput = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Normalize Input",
    position: [224, 464],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "dockerImageUrl", value: "={{ $json.body.dockerImageUrl || '' }}", type: "string" },
          { id: "2", name: "dockerfileContent", value: "={{ $json.body.dockerfileContent || '' }}", type: "string" },
          { id: "3", name: "imageRepo", value: "={{ ($json.body.dockerImageUrl || '').split(':')[0] }}", type: "string" },
          { id: "4", name: "imageTag", value: "={{ ($json.body.dockerImageUrl || '').split(':')[1] || 'latest' }}", type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ dockerImageUrl: "nginx:latest", dockerfileContent: "", imageRepo: "nginx", imageTag: "latest" }],
});

const fetchDockerImageMetadata = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Fetch Docker Image Metadata",
    position: [448, 464],
    parameters: {
      method: "GET",
      url: '=https://hub.docker.com/v2/repositories/{{ $json.imageRepo.includes("/") ? $json.imageRepo : "library/" + $json.imageRepo }}/',
      options: { response: { response: { fullResponse: false, neverError: true } }, timeout: 8000 },
    },
  },
  output: [{ description: "Official build of Nginx.", star_count: 18000 }],
});

const composeAppSpec = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Compose App Spec",
    position: [672, 464],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "specText", value: '=Docker image: {{ $("Normalize Input").item.json.dockerImageUrl }}\nImage description: {{ $json.description || "no description" }}\nDockerfile (if provided):\n{{ $("Normalize Input").item.json.dockerfileContent || "(none)" }}', type: "string" },
          { id: "2", name: "dockerImageUrl", value: '={{ $("Normalize Input").item.json.dockerImageUrl }}', type: "string" },
          { id: "3", name: "imageRepo", value: '={{ $("Normalize Input").item.json.imageRepo }}', type: "string" },
          { id: "4", name: "imageTag", value: '={{ $("Normalize Input").item.json.imageTag }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ specText: "Docker image: nginx:latest\nImage description: Official build of Nginx.\nDockerfile (if provided):\n(none)", dockerImageUrl: "nginx:latest", imageRepo: "nginx", imageTag: "latest" }],
});

const analyzerAgent = node({
  type: "@n8n/n8n-nodes-langchain.informationExtractor",
  version: 1.2,
  config: {
    name: "Analyzer Agent",
    position: [896, 352],
    parameters: {
      text: '={{ $json.specText }}',
      schemaType: "fromAttributes",
      attributes: {
        attributes: [
          { name: "runtime", type: "string", description: "Runtime such as node, python, go, ruby, java, dotnet, php, or static", required: true },
          { name: "ports", type: "string", description: "Comma-separated exposed ports (default 80 for nginx, 3000 for node)", required: true },
          { name: "estimatedMemoryMB", type: "number", description: "Memory in MB between 256 and 4096", required: true },
          { name: "estimatedCPU", type: "number", description: "CPU cores between 0.25 and 4", required: true },
        ],
      },
      options: {},
    },
    subnodes: { model: openAiGpt41 },
  },
  output: [{ runtime: "static", ports: "80", estimatedMemoryMB: 256, estimatedCPU: 0.25 }],
});

const architectAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 3.1,
  config: {
    name: "Architect Agent",
    position: [1248, 464],
    parameters: {
      promptType: "define",
      text: '=Recommend the best cloud deployment architecture for a containerized application. Return ONLY one of these labels and nothing else: "AWS Fargate", "GCP Cloud Run", or "Azure Container Apps".\n\nDocker image: {{ $("Compose App Spec").item.json.dockerImageUrl }}\nRuntime: {{ $json.runtime }}\nExposed ports: {{ $json.ports }}\nMemory (MB): {{ $json.estimatedMemoryMB }}\nCPU cores: {{ $json.estimatedCPU }}',
      options: { systemMessage: "You are an expert cloud architect. Always respond with only one of the supported labels." },
    },
    subnodes: { model: openAiGpt41 },
  },
  output: [{ output: "GCP Cloud Run" }],
});

const costEstimator = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Cost Estimator",
    position: [1600, 464],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "architecture", value: '={{ $json.output }}', type: "string" },
          { id: "2", name: "runtime", value: '={{ $("Analyzer Agent").item.json.runtime }}', type: "string" },
          { id: "3", name: "ports", value: '={{ $("Analyzer Agent").item.json.ports }}', type: "string" },
          { id: "4", name: "memoryMB", value: '={{ $("Analyzer Agent").item.json.estimatedMemoryMB }}', type: "number" },
          { id: "5", name: "cpuCores", value: '={{ $("Analyzer Agent").item.json.estimatedCPU }}', type: "number" },
          { id: "6", name: "awsCost", value: '={{ Math.round(38 + ($("Analyzer Agent").item.json.estimatedMemoryMB / 512) * 5 * ($("Analyzer Agent").item.json.estimatedCPU || 0.5)) }}', type: "number" },
          { id: "7", name: "gcpCost", value: '={{ Math.round(28 + ($("Analyzer Agent").item.json.estimatedMemoryMB / 512) * 4 * ($("Analyzer Agent").item.json.estimatedCPU || 0.5)) }}', type: "number" },
          { id: "8", name: "azureCost", value: '={{ Math.round(41 + ($("Analyzer Agent").item.json.estimatedMemoryMB / 512) * 5.3 * ($("Analyzer Agent").item.json.estimatedCPU || 0.5)) }}', type: "number" },
          { id: "9", name: "dockerImageUrl", value: '={{ $("Compose App Spec").item.json.dockerImageUrl }}', type: "string" },
          { id: "10", name: "recommendedProvider", value: '={{ $json.output.toLowerCase().includes("gcp") ? "gcp" : ($json.output.toLowerCase().includes("azure") ? "azure" : "aws") }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ architecture: "GCP Cloud Run", runtime: "static", ports: "80", memoryMB: 256, cpuCores: 0.25, awsCost: 40, gcpCost: 30, azureCost: 43, dockerImageUrl: "nginx:latest", recommendedProvider: "gcp" }],
});

const saveDeploymentRequest = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Save Deployment Request",
    position: [1824, 464],
    parameters: {
      operation: "executeQuery",
      query: "=INSERT INTO deployments (status, runtime, ports, architecture, docker_image_url, aws_cost, gcp_cost, azure_cost, created_at, updated_at) VALUES ('pending_approval', '{{ $json.runtime }}', '{{ $json.ports }}', '{{ $json.architecture }}', '{{ $json.dockerImageUrl }}', {{ $json.awsCost }}, {{ $json.gcpCost }}, {{ $json.azureCost }}, '{{ $now.toISO() }}', '{{ $now.toISO() }}') RETURNING id, status, architecture, docker_image_url, aws_cost, gcp_cost, azure_cost",
      options: {},
    },
  },
  output: [{ id: 42, status: "pending_approval", architecture: "GCP Cloud Run", docker_image_url: "nginx:latest", aws_cost: 40, gcp_cost: 30, azure_cost: 43 }],
});

const respondToFrontend = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.5,
  config: {
    name: "Respond to Frontend",
    position: [2048, 464],
    parameters: {
      respondWith: "json",
      responseBody: '={\n  "deploymentId": {{ $json.id }},\n  "status": "pending_approval",\n  "architecture": "{{ $("Cost Estimator").item.json.architecture }}",\n  "recommendedProvider": "{{ $("Cost Estimator").item.json.recommendedProvider }}",\n  "dockerImageUrl": "{{ $("Cost Estimator").item.json.dockerImageUrl }}",\n  "runtime": "{{ $("Cost Estimator").item.json.runtime }}",\n  "ports": "{{ $("Cost Estimator").item.json.ports }}",\n  "memoryMB": {{ $("Cost Estimator").item.json.memoryMB }},\n  "cpuCores": {{ $("Cost Estimator").item.json.cpuCores }},\n  "costs": { "aws": {{ $("Cost Estimator").item.json.awsCost }}, "gcp": {{ $("Cost Estimator").item.json.gcpCost }}, "azure": {{ $("Cost Estimator").item.json.azureCost }} },\n  "resumeUrl": "{{ $execution.resumeUrl }}"\n}',
      options: { responseCode: 200, responseHeaders: { entries: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "application/json" }] } },
    },
  },
  output: [{}],
});

const chatWait = node({
  type: "n8n-nodes-base.wait",
  version: 1.1,
  config: {
    name: "Chat Wait",
    position: [2272, 464],
    parameters: {
      resume: "webhook",
      httpMethod: "POST",
      options: { responseHeaders: { entries: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "application/json" }] } },
    },
  },
  output: [{ body: { type: "chat", message: "what is the cheapest?", history: [] } }],
});

const isFinalDecision = ifElse({
  version: 2.3,
  config: {
    name: "Is Final Decision?",
    position: [2496, 384],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: "={{ $json.body && $json.body.type }}", rightValue: "final", operator: { type: "string", operation: "equals" } }],
      },
      options: {},
    },
  },
});

// ── Final-decision TRUE branch ──

const extractFinalDecision = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract Final Decision",
    position: [2720, 288],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "action", value: "={{ $json.body.action }}", type: "string" },
          { id: "2", name: "provider", value: '={{ $json.body.provider || $("Cost Estimator").item.json.recommendedProvider }}', type: "string" },
          { id: "3", name: "plan", value: "={{ $json.body.plan || '' }}", type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ action: "approve", provider: "gcp", plan: "" }],
});

const respondFinalDecision = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.5,
  config: {
    name: "Respond Final Decision",
    position: [3008, 288],
    parameters: {
      respondWith: "json",
      responseBody: '={\n  "type": "final",\n  "status": "{{ $json.action === "approve" ? "deploying" : "rejected" }}",\n  "action": "{{ $json.action }}",\n  "provider": "{{ $json.provider }}",\n  "plan": "{{ $json.plan }}"\n}',
      options: { responseCode: 200, responseHeaders: { entries: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "application/json" }] } },
    },
  },
  output: [{}],
});

const checkFinalApproval = ifElse({
  version: 2.3,
  config: {
    name: "Check Final Approval",
    position: [3296, 288],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: false, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: "={{ $json.action }}", rightValue: "approve", operator: { type: "string", operation: "equals" } }],
      },
      options: {},
    },
  },
});

const captureApproval = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Capture Approval",
    position: [3520, 96],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentId", value: '={{ $("Save Deployment Request").item.json.id }}', type: "number" },
          { id: "2", name: "provider", value: '={{ $json.provider || $("Cost Estimator").item.json.recommendedProvider }}', type: "string" },
          { id: "3", name: "dockerImageUrl", value: '={{ $("Cost Estimator").item.json.dockerImageUrl }}', type: "string" },
          { id: "4", name: "runtime", value: '={{ $("Cost Estimator").item.json.runtime }}', type: "string" },
          { id: "5", name: "ports", value: '={{ $("Cost Estimator").item.json.ports }}', type: "string" },
          { id: "6", name: "memoryMB", value: '={{ $("Cost Estimator").item.json.memoryMB }}', type: "number" },
          { id: "7", name: "cpuCores", value: '={{ $("Cost Estimator").item.json.cpuCores }}', type: "number" },
          { id: "8", name: "architecture", value: '={{ $("Cost Estimator").item.json.architecture }}', type: "string" },
          { id: "9", name: "plan", value: '={{ $("Extract Final Decision").item.json.plan || "" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentId: 42, provider: "gcp", dockerImageUrl: "nginx:latest", runtime: "static", ports: "80", memoryMB: 256, cpuCores: 0.25, architecture: "GCP Cloud Run", plan: "" }],
});

const updateStatusApproved = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Update Status Approved",
    position: [3744, 96],
    parameters: {
      operation: "executeQuery",
      query: "=UPDATE deployments SET status = 'deploying', provider = '{{ $json.provider }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $json.deploymentId }}",
      options: {},
    },
  },
  output: [{}],
});

const deployAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 3.1,
  config: {
    name: "Deploy Agent",
    position: [3968, 96],
    parameters: {
      promptType: "define",
      text: '=Generate a deployment configuration. Return ONLY a single valid JSON object with no markdown fences.\n\nApproved deployment:\n- Provider: {{ $("Capture Approval").item.json.provider }}\n- Architecture: {{ $("Capture Approval").item.json.architecture }}\n- Docker image: {{ $("Capture Approval").item.json.dockerImageUrl }}\n- Runtime: {{ $("Capture Approval").item.json.runtime }}\n- Ports: {{ $("Capture Approval").item.json.ports }}\n- Memory: {{ $("Capture Approval").item.json.memoryMB }} MB\n- CPU: {{ $("Capture Approval").item.json.cpuCores }} cores\n- Deployment ID: {{ $("Capture Approval").item.json.deploymentId }}\n- User notes: {{ $("Capture Approval").item.json.plan }}\n\nReturn EXACTLY this shape (fill all fields, no nulls):\n{\n  "projectName": "<lowercase-hyphenated name max 40 chars, derived from the docker image>",\n  "image": "<fully-qualified docker image reference>",\n  "port": <primary exposed port as integer>,\n  "memoryMB": <memory as integer>,\n  "cpuLimit": <cpu as decimal e.g. 0.25>,\n  "healthCheckPath": "/health",\n  "region": "<provider region: us-east-1 for aws, us-central1 for gcp, eastus for azure>",\n  "envVars": { "NODE_ENV": "production" },\n  "gcpProject": "PROJECT_ID"\n}',
      options: { systemMessage: "You are a senior cloud infrastructure engineer. Generate production-ready deployment configurations. Use real region names, derive a meaningful kebab-case service name from the docker image, and use the correct port from the spec. Always return valid JSON only." },
    },
    subnodes: { model: openAiGpt41 },
  },
  output: [{ output: '{"projectName":"nginx","image":"nginx:latest","port":80,"memoryMB":256,"cpuLimit":0.25,"healthCheckPath":"/","region":"us-central1","envVars":{"NODE_ENV":"production"},"gcpProject":"PROJECT_ID"}' }],
});

const parseDeployConfig = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "Parse Deploy Config",
    position: [4320, 96],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: "const raw = $input.first().json.output || '{}';\nlet cfg;\ntry {\n  cfg = typeof raw === 'object' ? raw : JSON.parse(raw);\n} catch (e) {\n  const match = raw.match(/\\{[\\s\\S]*\\}/);\n  cfg = match ? JSON.parse(match[0]) : {};\n}\nconst approval = $('Capture Approval').first().json;\nreturn [{ json: {\n  deployConfig: cfg,\n  provider: approval.provider,\n  deploymentId: approval.deploymentId,\n  dockerImageUrl: approval.dockerImageUrl,\n  architecture: approval.architecture\n} }];",
    },
  },
  output: [{ deployConfig: { projectName: "nginx", image: "nginx:latest", port: 80, memoryMB: 256, cpuLimit: 0.25, healthCheckPath: "/", region: "us-central1", envVars: { NODE_ENV: "production" }, gcpProject: "PROJECT_ID" }, provider: "gcp", deploymentId: 42, dockerImageUrl: "nginx:latest", architecture: "GCP Cloud Run" }],
});

const routeByProvider = switchCase({
  version: 3.4,
  config: {
    name: "Route by Provider",
    position: [4544, 80],
    parameters: {
      mode: "rules",
      rules: {
        values: [
          { conditions: { combinator: "and", options: { caseSensitive: false, leftValue: "", typeValidation: "loose" }, conditions: [{ id: "1", leftValue: "={{ $json.provider }}", rightValue: "aws", operator: { type: "string", operation: "equals" } }] } },
          { conditions: { combinator: "and", options: { caseSensitive: false, leftValue: "", typeValidation: "loose" }, conditions: [{ id: "1", leftValue: "={{ $json.provider }}", rightValue: "gcp", operator: { type: "string", operation: "equals" } }] } },
          { conditions: { combinator: "and", options: { caseSensitive: false, leftValue: "", typeValidation: "loose" }, conditions: [{ id: "1", leftValue: "={{ $json.provider }}", rightValue: "azure", operator: { type: "string", operation: "equals" } }] } },
        ],
      },
      options: {},
    },
  },
});

// ── Final-decision FALSE branch (chat loop) ──

const buildChatHistory = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "Build Chat History",
    position: [2720, 480],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: "const body = $input.first().json.body || {};\nconst history = Array.isArray(body.history) ? body.history.slice() : [];\nconst userMessage = body.message || '';\nhistory.push({ role: 'user', content: userMessage });\nreturn [{ json: { history, userMessage } }];",
    },
  },
  output: [{ history: [{ role: "user", content: "what is the cheapest?" }], userMessage: "what is the cheapest?" }],
});

const deploymentChatAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 3.1,
  config: {
    name: "Deployment Chat Agent",
    position: [2944, 480],
    parameters: {
      promptType: "define",
      text: '=Conversation so far:\n{{ $json.history.map(function(m) { return m.role + ": " + m.content; }).join("\\n") }}\n\nRespond as the assistant to the latest user message.',
      options: { systemMessage: '=You are a cloud deployment advisor.\n\nDeployment context:\n- Docker image: {{ $("Cost Estimator").item.json.dockerImageUrl }}\n- Recommended architecture: {{ $("Cost Estimator").item.json.architecture }}\n- Runtime: {{ $("Cost Estimator").item.json.runtime }}\n- Ports: {{ $("Cost Estimator").item.json.ports }}\n- Memory: {{ $("Cost Estimator").item.json.memoryMB }} MB\n- CPU: {{ $("Cost Estimator").item.json.cpuCores }} cores\n- Monthly costs: AWS ${{ $("Cost Estimator").item.json.awsCost }}, GCP ${{ $("Cost Estimator").item.json.gcpCost }}, Azure ${{ $("Cost Estimator").item.json.azureCost }}\n\nHelp the user understand tradeoffs. When ready to commit, they send action (approve/reject) and provider (aws/gcp/azure). Keep responses concise and technical.' },
    },
    subnodes: { model: openAiGpt41 },
  },
  output: [{ output: "GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container." }],
});

const appendAiResponse = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "Append AI Response",
    position: [3296, 480],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: "const agentOutput = $input.first().json.output || '';\nconst prev = $('Build Chat History').first().json.history || [];\nconst history = prev.slice();\nhistory.push({ role: 'assistant', content: agentOutput });\nreturn [{ json: { reply: agentOutput, history } }];",
    },
  },
  output: [{ reply: "GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container.", history: [{ role: "user", content: "what is the cheapest?" }, { role: "assistant", content: "GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container." }] }],
});

const respondChatReply = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.5,
  config: {
    name: "Respond Chat Reply",
    position: [3520, 624],
    parameters: {
      respondWith: "json",
      responseBody: '={\n  "type": "chat",\n  "reply": {{ JSON.stringify($json.reply) }},\n  "history": {{ JSON.stringify($json.history) }},\n  "resumeUrl": "{{ $execution.resumeUrl }}",\n  "deploymentId": {{ $("Save Deployment Request").item.json.id }}\n}',
      options: { responseCode: 200, responseHeaders: { entries: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "application/json" }] } },
    },
  },
  output: [{}],
});

// ═══════════════════════════════════════════════════════════
//  REJECTED branch
// ═══════════════════════════════════════════════════════════

const updateStatusRejected = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Update Status Rejected",
    position: [3520, 288],
    parameters: {
      operation: "executeQuery",
      query: "=UPDATE deployments SET status = 'rejected', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $('Save Deployment Request').item.json.id }}",
      options: {},
    },
  },
  output: [{}],
});

// ═══════════════════════════════════════════════════════════
//  AWS DEPLOYMENT BRANCH  (with HTTP polling)
// ═══════════════════════════════════════════════════════════

const prepareAwsDeployment = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Prepare AWS Deployment",
    position: [5216, 0],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deployConfig", value: "={{ $json.deployConfig }}", type: "object" },
          { id: "2", name: "provider", value: "aws", type: "string" },
          { id: "3", name: "deploymentId", value: "={{ $json.deploymentId }}", type: "number" },
          { id: "4", name: "region", value: "={{ $json.deployConfig.region || 'us-east-1' }}", type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deployConfig: { projectName: "nginx", image: "nginx:latest", port: 80, memoryMB: 256, cpuLimit: 0.25, healthCheckPath: "/", region: "us-east-1", envVars: { NODE_ENV: "production" }, gcpProject: "PROJECT_ID" }, provider: "aws", deploymentId: 42, region: "us-east-1" }],
});

const deployToAws = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Deploy to AWS",
    position: [5440, 0],
    parameters: {
      method: "POST",
      url: '=https://apprunner.{{ $json.region }}.amazonaws.com/20200525/service',
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendBody: true,
      specifyBody: "json",
      jsonBody: '={{ { ServiceName: $json.deployConfig.projectName, SourceConfiguration: { ImageRepository: { ImageIdentifier: $json.deployConfig.image, ImageConfiguration: { Port: String($json.deployConfig.port), RuntimeEnvironmentVariables: $json.deployConfig.envVars || {} }, ImageRepositoryType: "ECR_PUBLIC" }, AutoDeploymentsEnabled: false }, InstanceConfiguration: { Cpu: $json.deployConfig.cpuLimit <= 0.5 ? "0.25 vCPU" : "0.5 vCPU", Memory: $json.deployConfig.memoryMB <= 512 ? "0.5 GB" : "1 GB" }, HealthCheckConfiguration: { Protocol: "HTTP", Path: $json.deployConfig.healthCheckPath || "/", HealthyThreshold: 1, UnhealthyThreshold: 5, Interval: 20, Timeout: 5 } } }}',
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 30000 },
    },
  },
  output: [{ body: { Service: { ServiceArn: "arn:aws:apprunner:us-east-1:123456789:service/nginx/abc123", ServiceId: "abc123", ServiceName: "nginx", ServiceUrl: "abc123.us-east-1.awsapprunner.com", Status: "OPERATION_IN_PROGRESS" } }, statusCode: 200 }],
});

// NEW: Poll AWS service status
const pollAwsStatus = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Poll AWS Status",
    position: [5680, -80],
    parameters: {
      method: "GET",
      url: '=https://apprunner.{{ $json.region }}.amazonaws.com/20200525/service/{{ $json.deployConfig.projectName }}',
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
    },
  },
  output: [{ body: { Service: { ServiceArn: "arn:aws:apprunner:us-east-1:123456789:service/nginx/abc123", ServiceId: "abc123", ServiceName: "nginx", ServiceUrl: "abc123.us-east-1.awsapprunner.com", Status: "RUNNING" } }, statusCode: 200 }],
});

const checkAwsReady = ifElse({
  version: 2.3,
  config: {
    name: "Check AWS Ready",
    position: [5920, -80],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: '={{ $json.body && $json.body.Service && $json.body.Service.Status }}', rightValue: "RUNNING", operator: { type: "string", operation: "equals" } }],
      },
      options: {},
    },
  },
});

const waitAwsPoll = node({
  type: "n8n-nodes-base.wait",
  version: 1.1,
  config: {
    name: "Wait AWS Poll",
    position: [5920, 80],
    parameters: { resume: "timeInterval", amount: 30, unit: "seconds" },
  },
  output: [{}],
});

const pollAwsStatus2 = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Poll AWS Status 2",
    position: [6160, 80],
    parameters: {
      method: "GET",
      url: '=https://apprunner.{{ $json.region }}.amazonaws.com/20200525/service/{{ $json.deployConfig.projectName }}',
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
    },
  },
  output: [{ body: { Service: { ServiceArn: "arn:aws:apprunner:us-east-1:123456789:service/nginx/abc123", ServiceId: "abc123", ServiceName: "nginx", ServiceUrl: "abc123.us-east-1.awsapprunner.com", Status: "RUNNING" } }, statusCode: 200 }],
});

const extractAwsUrl = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract AWS URL",
    position: [6400, -80],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentUrl", value: '={{ $json.body && $json.body.Service && $json.body.Service.ServiceUrl ? "https://" + $json.body.Service.ServiceUrl : "" }}', type: "string" },
          { id: "2", name: "deploymentId", value: '={{ $("Capture Approval").item.json.deploymentId }}', type: "number" },
          { id: "3", name: "provider", value: "aws", type: "string" },
          { id: "4", name: "healthCheckPath", value: '={{ $("Prepare AWS Deployment").item.json.deployConfig.healthCheckPath || "/" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentUrl: "https://abc123.us-east-1.awsapprunner.com", deploymentId: 42, provider: "aws", healthCheckPath: "/" }],
});

const extractAwsUrl2 = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract AWS URL 2",
    position: [6400, 80],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentUrl", value: '={{ $json.body && $json.body.Service && $json.body.Service.ServiceUrl ? "https://" + $json.body.Service.ServiceUrl : "" }}', type: "string" },
          { id: "2", name: "deploymentId", value: '={{ $("Capture Approval").item.json.deploymentId }}', type: "number" },
          { id: "3", name: "provider", value: "aws", type: "string" },
          { id: "4", name: "healthCheckPath", value: '={{ $("Prepare AWS Deployment").item.json.deployConfig.healthCheckPath || "/" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentUrl: "https://abc123.us-east-1.awsapprunner.com", deploymentId: 42, provider: "aws", healthCheckPath: "/" }],
});

// ═══════════════════════════════════════════════════════════
//  GCP DEPLOYMENT BRANCH  (with HTTP polling)
// ═══════════════════════════════════════════════════════════

const prepareGcpDeployment = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Prepare GCP Deployment",
    position: [4768, 192],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deployConfig", value: "={{ $json.deployConfig }}", type: "object" },
          { id: "2", name: "provider", value: "gcp", type: "string" },
          { id: "3", name: "deploymentId", value: "={{ $json.deploymentId }}", type: "number" },
          { id: "4", name: "region", value: "={{ $json.deployConfig.region || 'us-central1' }}", type: "string" },
          { id: "5", name: "gcpProject", value: "={{ $json.deployConfig.gcpProject || 'PROJECT_ID' }}", type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deployConfig: { projectName: "nginx", image: "nginx:latest", port: 80, memoryMB: 256, cpuLimit: 0.25, healthCheckPath: "/", region: "us-central1", envVars: { NODE_ENV: "production" }, gcpProject: "PROJECT_ID" }, provider: "gcp", deploymentId: 42, region: "us-central1", gcpProject: "PROJECT_ID" }],
});

const deployToGcp = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Deploy to GCP",
    position: [4992, 192],
    parameters: {
      method: "POST",
      url: '=https://run.googleapis.com/v2/projects/{{ $json.gcpProject }}/locations/{{ $json.region }}/services',
      authentication: "genericCredentialType",
      genericAuthType: "oAuth2Api",
      sendBody: true,
      specifyBody: "json",
      jsonBody: '={{ { name: "projects/" + $json.gcpProject + "/locations/" + $json.region + "/services/" + $json.deployConfig.projectName, template: { containers: [{ image: $json.deployConfig.image, ports: [{ containerPort: $json.deployConfig.port }], resources: { limits: { cpu: String($json.deployConfig.cpuLimit), memory: $json.deployConfig.memoryMB + "Mi" } }, env: Object.entries($json.deployConfig.envVars || {}).map(function(e) { return { name: e[0], value: e[1] }; }) }], scaling: { minInstanceCount: 0, maxInstanceCount: 10 } }, ingress: "INGRESS_TRAFFIC_ALL" } }}',
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 30000 },
    },
  },
  output: [{ body: { name: "projects/PROJECT_ID/locations/us-central1/services/nginx", uri: "https://nginx-abc123-uc.a.run.app", conditions: [{ type: "Ready", status: "True", reason: "RevisionReady" }] }, statusCode: 200 }],
});

// NEW: Poll GCP service status (replaces blind wait)
const pollGcpStatus = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Poll GCP Status",
    position: [5230, 100],
    parameters: {
      method: "GET",
      url: '=https://run.googleapis.com/v2/projects/{{ $("Prepare GCP Deployment").item.json.gcpProject }}/locations/{{ $("Prepare GCP Deployment").item.json.region }}/services/{{ $("Prepare GCP Deployment").item.json.deployConfig.projectName }}',
      authentication: "genericCredentialType",
      genericAuthType: "oAuth2Api",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
    },
  },
  output: [{ body: { name: "projects/PROJECT_ID/locations/us-central1/services/nginx", uri: "https://nginx-abc123-uc.a.run.app", conditions: [{ type: "Ready", status: "True", reason: "RevisionReady" }] }, statusCode: 200 }],
});

const checkGcpReady = ifElse({
  version: 2.3,
  config: {
    name: "Check GCP Ready",
    position: [5470, 100],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: '={{ $json.body && $json.body.conditions && $json.body.conditions[0] && $json.body.conditions[0].status }}', rightValue: "True", operator: { type: "string", operation: "equals" } }],
      },
      options: {},
    },
  },
});

const waitGcpPoll = node({
  type: "n8n-nodes-base.wait",
  version: 1.1,
  config: {
    name: "Wait GCP Poll",
    position: [5470, 280],
    parameters: { resume: "timeInterval", amount: 30, unit: "seconds" },
  },
  output: [{}],
});

const pollGcpStatus2 = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Poll GCP Status 2",
    position: [5710, 280],
    parameters: {
      method: "GET",
      url: '=https://run.googleapis.com/v2/projects/{{ $("Prepare GCP Deployment").item.json.gcpProject }}/locations/{{ $("Prepare GCP Deployment").item.json.region }}/services/{{ $("Prepare GCP Deployment").item.json.deployConfig.projectName }}',
      authentication: "genericCredentialType",
      genericAuthType: "oAuth2Api",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
    },
  },
  output: [{ body: { name: "projects/PROJECT_ID/locations/us-central1/services/nginx", uri: "https://nginx-abc123-uc.a.run.app", conditions: [{ type: "Ready", status: "True", reason: "RevisionReady" }] }, statusCode: 200 }],
});

const extractGcpUrl = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract GCP URL",
    position: [5950, 100],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentUrl", value: '={{ $json.body && $json.body.uri ? $json.body.uri : "" }}', type: "string" },
          { id: "2", name: "deploymentId", value: '={{ $("Capture Approval").item.json.deploymentId }}', type: "number" },
          { id: "3", name: "provider", value: "gcp", type: "string" },
          { id: "4", name: "healthCheckPath", value: '={{ $("Prepare GCP Deployment").item.json.deployConfig.healthCheckPath || "/" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentUrl: "https://nginx-abc123-uc.a.run.app", deploymentId: 42, provider: "gcp", healthCheckPath: "/" }],
});

const extractGcpUrl2 = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract GCP URL 2",
    position: [5950, 280],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentUrl", value: '={{ $json.body && $json.body.uri ? $json.body.uri : "" }}', type: "string" },
          { id: "2", name: "deploymentId", value: '={{ $("Capture Approval").item.json.deploymentId }}', type: "number" },
          { id: "3", name: "provider", value: "gcp", type: "string" },
          { id: "4", name: "healthCheckPath", value: '={{ $("Prepare GCP Deployment").item.json.deployConfig.healthCheckPath || "/" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentUrl: "https://nginx-abc123-uc.a.run.app", deploymentId: 42, provider: "gcp", healthCheckPath: "/" }],
});

// ═══════════════════════════════════════════════════════════
//  AZURE DEPLOYMENT BRANCH  (with HTTP polling)
// ═══════════════════════════════════════════════════════════

const prepareAzureDeployment = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Prepare Azure Deployment",
    position: [5216, 480],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deployConfig", value: "={{ $json.deployConfig }}", type: "object" },
          { id: "2", name: "provider", value: "azure", type: "string" },
          { id: "3", name: "deploymentId", value: "={{ $json.deploymentId }}", type: "number" },
          { id: "4", name: "region", value: "={{ $json.deployConfig.region || 'eastus' }}", type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deployConfig: { projectName: "nginx", image: "nginx:latest", port: 80, memoryMB: 256, cpuLimit: 0.25, healthCheckPath: "/", region: "eastus", envVars: { NODE_ENV: "production" }, gcpProject: "PROJECT_ID" }, provider: "azure", deploymentId: 42, region: "eastus" }],
});

const deployToAzure = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Deploy to Azure",
    position: [5440, 480],
    parameters: {
      method: "PUT",
      url: '=https://management.azure.com/subscriptions/SUB_ID/resourceGroups/RG_NAME/providers/Microsoft.App/containerApps/{{ $json.deployConfig.projectName }}?api-version=2024-03-01',
      authentication: "genericCredentialType",
      genericAuthType: "oAuth2Api",
      sendBody: true,
      specifyBody: "json",
      jsonBody: '={{ { location: $json.region, properties: { configuration: { ingress: { external: true, targetPort: $json.deployConfig.port, transport: "auto" } }, template: { containers: [{ name: $json.deployConfig.projectName, image: $json.deployConfig.image, resources: { cpu: $json.deployConfig.cpuLimit, memory: $json.deployConfig.memoryMB + "Mi" }, env: Object.entries($json.deployConfig.envVars || {}).map(function(e) { return { name: e[0], value: e[1] }; }) }], scale: { minReplicas: 0, maxReplicas: 10 } } } } }}',
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 30000 },
    },
  },
  output: [{ body: { properties: { provisioningState: "Succeeded", configuration: { ingress: { fqdn: "nginx.happywave-abc123.eastus.azurecontainerapps.io" } } } }, statusCode: 200 }],
});

// NEW: Poll Azure container app status
const pollAzureStatus = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Poll Azure Status",
    position: [5680, 380],
    parameters: {
      method: "GET",
      url: '=https://management.azure.com/subscriptions/SUB_ID/resourceGroups/RG_NAME/providers/Microsoft.App/containerApps/{{ $("Prepare Azure Deployment").item.json.deployConfig.projectName }}?api-version=2024-03-01',
      authentication: "genericCredentialType",
      genericAuthType: "oAuth2Api",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
    },
  },
  output: [{ body: { properties: { provisioningState: "Succeeded", configuration: { ingress: { fqdn: "nginx.happywave-abc123.eastus.azurecontainerapps.io" } } } }, statusCode: 200 }],
});

const checkAzureReady = ifElse({
  version: 2.3,
  config: {
    name: "Check Azure Ready",
    position: [5920, 380],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: '={{ $json.body && $json.body.properties && $json.body.properties.provisioningState }}', rightValue: "Succeeded", operator: { type: "string", operation: "equals" } }],
      },
      options: {},
    },
  },
});

const waitAzurePoll = node({
  type: "n8n-nodes-base.wait",
  version: 1.1,
  config: {
    name: "Wait Azure Poll",
    position: [5920, 560],
    parameters: { resume: "timeInterval", amount: 30, unit: "seconds" },
  },
  output: [{}],
});

const pollAzureStatus2 = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Poll Azure Status 2",
    position: [6160, 560],
    parameters: {
      method: "GET",
      url: '=https://management.azure.com/subscriptions/SUB_ID/resourceGroups/RG_NAME/providers/Microsoft.App/containerApps/{{ $("Prepare Azure Deployment").item.json.deployConfig.projectName }}?api-version=2024-03-01',
      authentication: "genericCredentialType",
      genericAuthType: "oAuth2Api",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
    },
  },
  output: [{ body: { properties: { provisioningState: "Succeeded", configuration: { ingress: { fqdn: "nginx.happywave-abc123.eastus.azurecontainerapps.io" } } } }, statusCode: 200 }],
});

const extractAzureUrl = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract Azure URL",
    position: [6400, 380],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentUrl", value: '={{ $json.body && $json.body.properties && $json.body.properties.configuration && $json.body.properties.configuration.ingress && $json.body.properties.configuration.ingress.fqdn ? "https://" + $json.body.properties.configuration.ingress.fqdn : "" }}', type: "string" },
          { id: "2", name: "deploymentId", value: '={{ $("Capture Approval").item.json.deploymentId }}', type: "number" },
          { id: "3", name: "provider", value: "azure", type: "string" },
          { id: "4", name: "healthCheckPath", value: '={{ $("Prepare Azure Deployment").item.json.deployConfig.healthCheckPath || "/" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentUrl: "https://nginx.happywave-abc123.eastus.azurecontainerapps.io", deploymentId: 42, provider: "azure", healthCheckPath: "/" }],
});

const extractAzureUrl2 = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract Azure URL 2",
    position: [6400, 560],
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          { id: "1", name: "deploymentUrl", value: '={{ $json.body && $json.body.properties && $json.body.properties.configuration && $json.body.properties.configuration.ingress && $json.body.properties.configuration.ingress.fqdn ? "https://" + $json.body.properties.configuration.ingress.fqdn : "" }}', type: "string" },
          { id: "2", name: "deploymentId", value: '={{ $("Capture Approval").item.json.deploymentId }}', type: "number" },
          { id: "3", name: "provider", value: "azure", type: "string" },
          { id: "4", name: "healthCheckPath", value: '={{ $("Prepare Azure Deployment").item.json.deployConfig.healthCheckPath || "/" }}', type: "string" },
        ],
      },
      options: {},
    },
  },
  output: [{ deploymentUrl: "https://nginx.happywave-abc123.eastus.azurecontainerapps.io", deploymentId: 42, provider: "azure", healthCheckPath: "/" }],
});

// ═══════════════════════════════════════════════════════════
//  SHARED POST-DEPLOYMENT HEALTH CHECK
// ═══════════════════════════════════════════════════════════

const healthCheck = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Health Check",
    position: [6640, 200],
    parameters: {
      method: "GET",
      url: '={{ $json.deploymentUrl + ($json.healthCheckPath || "/") }}',
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 10000 },
    },
  },
  output: [{ statusCode: 200, body: "OK" }],
});

const collectHealthResult = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "Collect Health Result",
    position: [6880, 200],
    parameters: {
      mode: "runOnceForAllItems",
      language: "javaScript",
      jsCode: "function tryGet(name) { try { return $(name).first().json; } catch(e) { return null; } }\nconst awsData  = tryGet('Extract AWS URL');\nconst awsData2 = tryGet('Extract AWS URL 2');\nconst gcpData  = tryGet('Extract GCP URL');\nconst gcpData2 = tryGet('Extract GCP URL 2');\nconst azData   = tryGet('Extract Azure URL');\nconst azData2  = tryGet('Extract Azure URL 2');\nconst urlData  = awsData || awsData2 || gcpData || gcpData2 || azData || azData2 || {};\nconst statusCode = $input.first().json.statusCode || 0;\nreturn [{ json: {\n  statusCode,\n  deploymentUrl: urlData.deploymentUrl || '',\n  deploymentId: urlData.deploymentId || $('Capture Approval').first().json.deploymentId,\n  provider: urlData.provider || $('Capture Approval').first().json.provider\n} }];",
    },
  },
  output: [{ statusCode: 200, deploymentUrl: "https://nginx-abc123-uc.a.run.app", deploymentId: 42, provider: "gcp" }],
});

const checkHealthStatus = ifElse({
  version: 2.3,
  config: {
    name: "Check Health Status",
    position: [7120, 200],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: "={{ $json.statusCode }}", rightValue: 200, operator: { type: "number", operation: "equals" } }],
      },
      options: {},
    },
  },
});

const updateStatusSuccess = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Update Status Success",
    position: [7360, 120],
    parameters: {
      operation: "executeQuery",
      query: "=UPDATE deployments SET status = 'deployed', health_status = 'healthy', deployment_url = '{{ $json.deploymentUrl }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $json.deploymentId }}",
      options: {},
    },
  },
  output: [{}],
});

const debuggerAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 3.1,
  config: {
    name: "Debugger Agent",
    position: [7360, 320],
    parameters: {
      promptType: "define",
      text: '=A deployment health check returned HTTP {{ $json.statusCode }} for a {{ $json.provider }} deployment (ID: {{ $json.deploymentId }}, URL: {{ $json.deploymentUrl }}).\n\nReturn ONLY raw JSON, no markdown:\n{\n  "rootCause": "specific description of likely failure",\n  "suggestedFix": "concrete corrective action",\n  "shouldRetry": true\n}',
      options: { systemMessage: "You are a deployment incident-response engineer. Analyze cloud deployment failures and produce actionable JSON recommendations. Consider: container startup errors, missing env vars, port mismatches, cold-start timeouts, permission issues." },
    },
    subnodes: { model: openAiGpt41 },
  },
  output: [{ output: '{"rootCause":"Container port mismatch","suggestedFix":"Verify the container exposes the correct port","shouldRetry":true}' }],
});

const updateStatusFailed = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Update Status Failed",
    position: [7600, 320],
    parameters: {
      operation: "executeQuery",
      query: "=UPDATE deployments SET status = 'failed', health_status = 'unhealthy', error_log = '{{ JSON.stringify($json.output).replaceAll(\"'\", \"''\") }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $('Collect Health Result').item.json.deploymentId }}",
      options: {},
    },
  },
  output: [{}],
});

// ═══════════════════════════════════════════════════════════
//  MONITORING BRANCH
// ═══════════════════════════════════════════════════════════

const fetchActiveDeployments = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Fetch Active Deployments",
    position: [224, 848],
    parameters: {
      operation: "executeQuery",
      query: "SELECT id, deployment_url FROM deployments WHERE status = 'deployed' AND health_status = 'healthy'",
      options: {},
    },
  },
  output: [{ id: 42, deployment_url: "https://nginx-abc123-uc.a.run.app" }],
});

const monitorHealth = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Monitor Health",
    position: [448, 848],
    parameters: {
      method: "GET",
      url: "={{ $json.deployment_url }}",
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 10000 },
    },
  },
  output: [{ statusCode: 200 }],
});

const checkMonitorStatus = ifElse({
  version: 2.3,
  config: {
    name: "Check Monitor Status",
    position: [672, 848],
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "1", leftValue: "={{ $json.statusCode }}", rightValue: 200, operator: { type: "number", operation: "notEquals" } }],
      },
      options: {},
    },
  },
});

const markDeploymentUnhealthy = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Mark Deployment Unhealthy",
    position: [896, 848],
    parameters: {
      operation: "executeQuery",
      query: "=UPDATE deployments SET health_status = 'unhealthy', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $('Fetch Active Deployments').item.json.id }}",
      options: {},
    },
  },
  output: [{}],
});

// ═══════════════════════════════════════════════════════════
//  WORKFLOW COMPOSITION
// ═══════════════════════════════════════════════════════════

export default workflow("Co7HN1Zf7FQT6YSa", "Agentic IDP — Self-Healing Deployment Pipeline")
  // Triggers
  .add(deploymentWebhook)
  .add(monitoringSchedule)

  // Main inbound pipeline
  .add(deploymentWebhook)
  .to(normalizeInput)
  .to(fetchDockerImageMetadata)
  .to(composeAppSpec)
  .to(analyzerAgent)
  .to(architectAgent)
  .to(costEstimator)
  .to(saveDeploymentRequest)
  .to(respondToFrontend)
  .to(chatWait)
  .to(isFinalDecision)

  // Final-decision TRUE branch
  .add(isFinalDecision.onTrue(extractFinalDecision.to(respondFinalDecision.to(checkFinalApproval
    .onTrue(captureApproval.to(updateStatusApproved.to(deployAgent.to(parseDeployConfig.to(routeByProvider
      // AWS branch with polling
      .onCase(0, prepareAwsDeployment.to(deployToAws.to(pollAwsStatus.to(checkAwsReady
        .onTrue(extractAwsUrl.to(healthCheck))
        .onFalse(waitAwsPoll.to(pollAwsStatus2.to(extractAwsUrl2.to(healthCheck))))
      ))))
      // GCP branch with polling
      .onCase(1, prepareGcpDeployment.to(deployToGcp.to(pollGcpStatus.to(checkGcpReady
        .onTrue(extractGcpUrl.to(healthCheck))
        .onFalse(waitGcpPoll.to(pollGcpStatus2.to(extractGcpUrl2.to(healthCheck))))
      ))))
      // Azure branch with polling
      .onCase(2, prepareAzureDeployment.to(deployToAzure.to(pollAzureStatus.to(checkAzureReady
        .onTrue(extractAzureUrl.to(healthCheck))
        .onFalse(waitAzurePoll.to(pollAzureStatus2.to(extractAzureUrl2.to(healthCheck))))
      ))))
    )))))
    .onFalse(updateStatusRejected)
  ))))

  // Final-decision FALSE branch (chat loop)
  .add(isFinalDecision.onFalse(buildChatHistory.to(deploymentChatAgent.to(appendAiResponse.to(respondChatReply.to(chatWait))))))

  // Post-deployment health
  .add(healthCheck)
  .to(collectHealthResult)
  .to(checkHealthStatus
    .onTrue(updateStatusSuccess)
    .onFalse(debuggerAgent.to(updateStatusFailed))
  )

  // Monitoring branch
  .add(monitoringSchedule)
  .to(fetchActiveDeployments)
  .to(monitorHealth)
  .to(checkMonitorStatus
    .onTrue(markDeploymentUnhealthy)
  );
