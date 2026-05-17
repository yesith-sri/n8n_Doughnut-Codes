import {
  workflow,
  node,
  trigger,
  ifElse,
  languageModel,
  expr,
} from "@n8n/workflow-sdk";

/* =====================================================================
   Agentic IDP — Brain-only workflow
   n8n handles: analysis → recommendation → cost → chat → final decision
   The frontend handles cloud provisioning after the human commits.
   ===================================================================== */

// ---------- Shared AI model ------------------------------------------------
const openAiModel = languageModel({
  type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  version: 1.3,
  config: {
    name: "OpenAI GPT-4.1",
    parameters: {
      model: { __rl: true, value: "gpt-4.1", mode: "list", cachedResultName: "gpt-4.1" },
      options: {},
    },
    position: [4488, 320],
  },
});

// ---------- Triggers -------------------------------------------------------
const deploymentWebhook = trigger({
  type: "n8n-nodes-base.webhook",
  version: 2.1,
  config: {
    name: "Deployment Webhook",
    parameters: {
      httpMethod: "POST",
      path: "deploy",
      responseMode: "responseNode",
      options: { allowedOrigins: "*" },
    },
    position: [0, 456],
  },
  output: [{ body: { dockerImageUrl: "nginx:latest" } }],
});

const monitoringSchedule = trigger({
  type: "n8n-nodes-base.scheduleTrigger",
  version: 1.3,
  config: {
    name: "Monitoring Schedule",
    parameters: {
      rule: { interval: [{ field: "minutes" }] },
    },
    position: [0, 872],
  },
  output: [{}],
});

// ---------- Main pipeline nodes --------------------------------------------
const normalizeInput = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Normalize Input",
    parameters: {
      assignments: {
        assignments: [
          { id: "1", name: "dockerImageUrl", value: expr('={{ $json.body.dockerImageUrl || "" }}'), type: "string" },
          { id: "2", name: "dockerfileContent", value: expr('={{ $json.body.dockerfileContent || "" }}'), type: "string" },
          { id: "3", name: "imageRepo", value: expr('={{ ($json.body.dockerImageUrl || "").split(":")[0] }}'), type: "string" },
          { id: "4", name: "imageTag", value: expr('={{ ($json.body.dockerImageUrl || "").split(":")[1] || "latest" }}'), type: "string" },
          { id: "5", name: "forgeProvisionerUrl", value: expr('={{ $json.body.forgeProvisionerUrl || "" }}'), type: "string" },
        ],
      },
      options: {},
    },
    position: [224, 456],
  },
  output: [{ dockerImageUrl: "nginx:latest", dockerfileContent: "", imageRepo: "nginx", imageTag: "latest", forgeProvisionerUrl: "" }],
});

const fetchDockerImageMetadata = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Fetch Docker Image Metadata",
    parameters: {
      url: expr('=https://hub.docker.com/v2/repositories/{{ $json.imageRepo.includes("/") ? $json.imageRepo : "library/" + $json.imageRepo }}/'),
      options: { response: { response: { neverError: true } }, timeout: 8000 },
    },
    position: [448, 456],
  },
  output: [{ description: "Official nginx image" }],
});

const composeAppSpec = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Compose App Spec",
    parameters: {
      assignments: {
        assignments: [
          { id: "1", name: "specText", value: expr('=Docker image: {{ $("Normalize Input").item.json.dockerImageUrl }}\nImage description: {{ $json.description || "no description" }}\nDockerfile (if provided):\n{{ $("Normalize Input").item.json.dockerfileContent || "(none)" }}'), type: "string" },
          { id: "2", name: "dockerImageUrl", value: expr('={{ $("Normalize Input").item.json.dockerImageUrl }}'), type: "string" },
          { id: "3", name: "forgeProvisionerUrl", value: expr('={{ $("Normalize Input").item.json.forgeProvisionerUrl }}'), type: "string" },
        ],
      },
      options: {},
    },
    position: [672, 456],
  },
  output: [{ specText: "Docker image: nginx:latest", dockerImageUrl: "nginx:latest", forgeProvisionerUrl: "" }],
});

const analyzerAgent = node({
  type: "@n8n/n8n-nodes-langchain.informationExtractor",
  version: 1.2,
  config: {
    name: "Analyzer Agent",
    parameters: {
      text: expr('={{ $json.specText }}'),
      attributes: {
        attributes: [
          { name: "runtime", description: "Runtime such as node, python, go, ruby, java, dotnet, php, nginx, or static", required: true },
          { name: "ports", description: "Comma-separated exposed ports; default 80 for nginx/static and 3000 for Node.js", required: true },
          { name: "estimatedMemoryMB", type: "number", description: "Memory in MB between 512 and 4096", required: true },
          { name: "estimatedCPU", type: "number", description: "CPU cores between 0.25 and 4", required: true },
        ],
      },
      options: {},
    },
    subnodes: { model: openAiModel },
    position: [896, 456],
  },
  output: [{ output: { runtime: "static", ports: "80", estimatedMemoryMB: 512, estimatedCPU: 0.25 } }],
});

const flattenAnalyzerOutput = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Flatten Analyzer Output",
    parameters: {
      assignments: {
        assignments: [
          { id: "1", name: "runtime", value: expr('={{ $json.output.runtime }}'), type: "string" },
          { id: "2", name: "ports", value: expr('={{ $json.output.ports }}'), type: "string" },
          { id: "3", name: "estimatedMemoryMB", value: expr('={{ $json.output.estimatedMemoryMB }}'), type: "number" },
          { id: "4", name: "estimatedCPU", value: expr('={{ $json.output.estimatedCPU }}'), type: "number" },
          { id: "5", name: "dockerImageUrl", value: expr('={{ $("Compose App Spec").item.json.dockerImageUrl }}'), type: "string" },
          { id: "6", name: "forgeProvisionerUrl", value: expr('={{ $("Compose App Spec").item.json.forgeProvisionerUrl }}'), type: "string" },
        ],
      },
      options: {},
    },
    position: [1248, 456],
  },
  output: [{ runtime: "static", ports: "80", estimatedMemoryMB: 512, estimatedCPU: 0.25, dockerImageUrl: "nginx:latest", forgeProvisionerUrl: "" }],
});

const architectAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 3.1,
  config: {
    name: "Architect Agent",
    parameters: {
      promptType: "define",
      text: expr('=Recommend the best architecture for this AWS Docker Hub POC. Return ONLY this label and nothing else: "AWS ECS Fargate".\n\nDocker image: {{ $json.dockerImageUrl }}\nRuntime: {{ $json.runtime }}\nExposed ports: {{ $json.ports }}\nMemory (MB): {{ $json.estimatedMemoryMB }}\nCPU cores: {{ $json.estimatedCPU }}'),
      options: {
        systemMessage: "You are an expert cloud architect. For this POC, choose AWS ECS Fargate for public Docker Hub container images.",
      },
    },
    subnodes: { model: openAiModel },
    position: [1472, 456],
  },
  output: [{ output: "AWS ECS Fargate" }],
});

const costEstimator = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Cost Estimator",
    parameters: {
      assignments: {
        assignments: [
          { id: "1", name: "architecture", value: expr('={{ $json.output }}'), type: "string" },
          { id: "2", name: "runtime", value: expr('={{ $("Flatten Analyzer Output").item.json.runtime }}'), type: "string" },
          { id: "3", name: "ports", value: expr('={{ $("Flatten Analyzer Output").item.json.ports }}'), type: "string" },
          { id: "4", name: "memoryMB", value: expr('={{ $("Flatten Analyzer Output").item.json.estimatedMemoryMB }}'), type: "number" },
          { id: "5", name: "cpuCores", value: expr('={{ $("Flatten Analyzer Output").item.json.estimatedCPU }}'), type: "number" },
          { id: "6", name: "awsCost", value: expr('={{ Math.round(24 + ($("Flatten Analyzer Output").item.json.estimatedMemoryMB / 512) * 8 * ($("Flatten Analyzer Output").item.json.estimatedCPU || 0.5)) }}'), type: "number" },
          { id: "7", name: "gcpCost", value: expr('={{ Math.round(28 + ($("Flatten Analyzer Output").item.json.estimatedMemoryMB / 512) * 4 * ($("Flatten Analyzer Output").item.json.estimatedCPU || 0.5)) }}'), type: "number" },
          { id: "8", name: "azureCost", value: expr('={{ Math.round(41 + ($("Flatten Analyzer Output").item.json.estimatedMemoryMB / 512) * 5.3 * ($("Flatten Analyzer Output").item.json.estimatedCPU || 0.5)) }}'), type: "number" },
          { id: "9", name: "dockerImageUrl", value: expr('={{ $("Flatten Analyzer Output").item.json.dockerImageUrl }}'), type: "string" },
          { id: "10", name: "recommendedProvider", value: "aws", type: "string" },
          { id: "11", name: "forgeProvisionerUrl", value: expr('={{ $("Flatten Analyzer Output").item.json.forgeProvisionerUrl }}'), type: "string" },
        ],
      },
      options: {},
    },
    position: [1824, 456],
  },
  output: [{ architecture: "AWS ECS Fargate", runtime: "static", ports: "80", memoryMB: 512, cpuCores: 0.25, awsCost: 32, gcpCost: 30, azureCost: 42, dockerImageUrl: "nginx:latest", recommendedProvider: "aws", forgeProvisionerUrl: "" }],
});

const saveDeploymentRequest = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Save Deployment Request",
    parameters: {
      operation: "executeQuery",
      query: expr("=INSERT INTO deployments (status, runtime, ports, architecture, docker_image_url, aws_cost, gcp_cost, azure_cost, created_at, updated_at) VALUES ('pending_approval', '{{ $json.runtime }}', '{{ $json.ports }}', '{{ $json.architecture }}', '{{ $json.dockerImageUrl }}', {{ $json.awsCost }}, {{ $json.gcpCost }}, {{ $json.azureCost }}, '{{ $now.toISO() }}', '{{ $now.toISO() }}') RETURNING id, status, architecture, docker_image_url, aws_cost, gcp_cost, azure_cost"),
      options: {},
    },
    position: [2048, 456],
  },
  output: [{ id: 42, status: "pending_approval", architecture: "AWS ECS Fargate", docker_image_url: "nginx:latest", aws_cost: 32, gcp_cost: 30, azure_cost: 42 }],
});

const respondToFrontend = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.5,
  config: {
    name: "Respond to Frontend",
    parameters: {
      respondWith: "json",
      responseBody: expr('={\n  "deploymentId": {{ $json.id }},\n  "status": "pending_approval",\n  "architecture": "{{ $("Cost Estimator").item.json.architecture }}",\n  "recommendedProvider": "aws",\n  "dockerImageUrl": "{{ $("Cost Estimator").item.json.dockerImageUrl }}",\n  "runtime": "{{ $("Cost Estimator").item.json.runtime }}",\n  "ports": "{{ $("Cost Estimator").item.json.ports }}",\n  "memoryMB": {{ $("Cost Estimator").item.json.memoryMB }},\n  "cpuCores": {{ $("Cost Estimator").item.json.cpuCores }},\n  "costs": { "aws": {{ $("Cost Estimator").item.json.awsCost }}, "gcp": {{ $("Cost Estimator").item.json.gcpCost }}, "azure": {{ $("Cost Estimator").item.json.azureCost }} },\n  "resumeUrl": "{{ $execution.resumeUrl }}"\n}'),
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Content-Type", value: "application/json" },
          ],
        },
      },
    },
    position: [2272, 456],
  },
  output: [{ deploymentId: 42, status: "pending_approval", resumeUrl: "https://example.com/resume" }],
});

const chatWait = node({
  type: "n8n-nodes-base.wait",
  version: 1.1,
  config: {
    name: "Chat Wait",
    parameters: {
      resume: "webhook",
      httpMethod: "POST",
      options: {
        responseHeaders: {
          entries: [
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Content-Type", value: "application/json" },
          ],
        },
      },
    },
    position: [2496, 456],
  },
  output: [{ body: { type: "chat", message: "hello", history: [] } }],
});

const isFinalDecision = ifElse({
  version: 2.3,
  config: {
    name: "Is Final Decision?",
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 1 },
        conditions: [
          { id: "1", leftValue: expr('={{ $json.body && $json.body.type }}'), rightValue: "final", operator: { type: "string", operation: "equals" } },
        ],
      },
      options: {},
    },
    position: [2720, 384],
  },
});

const extractFinalDecision = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Extract Final Decision",
    parameters: {
      assignments: {
        assignments: [
          { id: "1", name: "action", value: expr('={{ $json.body.action }}'), type: "string" },
          { id: "2", name: "provider", value: expr('={{ $json.body.provider || "aws" }}'), type: "string" },
          { id: "3", name: "plan", value: expr('={{ $json.body.plan || "" }}'), type: "string" },
        ],
      },
      options: {},
    },
    position: [2944, 288],
  },
  output: [{ action: "approve", provider: "aws", plan: "" }],
});

const respondFinalDecision = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.5,
  config: {
    name: "Respond Final Decision",
    parameters: {
      respondWith: "json",
      responseBody: expr('={\n  "type": "final",\n  "status": "{{ $json.action === \'approve\' ? \'deploying\' : \'rejected\' }}",\n  "action": "{{ $json.action }}",\n  "provider": "{{ $json.provider }}",\n  "plan": "{{ $json.plan }}"\n}'),
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Content-Type", value: "application/json" },
          ],
        },
      },
    },
    position: [3232, 288],
  },
  output: [{ type: "final", status: "deploying", action: "approve", provider: "aws", plan: "" }],
});

const checkFinalApproval = ifElse({
  version: 2.3,
  config: {
    name: "Check Final Approval",
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: false, leftValue: "", typeValidation: "loose", version: 1 },
        conditions: [
          { id: "1", leftValue: expr('={{ $json.action }}'), rightValue: "approve", operator: { type: "string", operation: "equals" } },
        ],
      },
      options: {},
    },
    position: [3520, 288],
  },
});

const captureApproval = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: {
    name: "Capture Approval",
    parameters: {
      assignments: {
        assignments: [
          { id: "1", name: "deploymentId", value: expr('={{ $("Save Deployment Request").item.json.id }}'), type: "number" },
          { id: "2", name: "provider", value: expr('={{ $("Extract Final Decision").item.json.provider || "aws" }}'), type: "string" },
          { id: "3", name: "dockerImageUrl", value: expr('={{ $("Cost Estimator").item.json.dockerImageUrl }}'), type: "string" },
          { id: "4", name: "runtime", value: expr('={{ $("Cost Estimator").item.json.runtime }}'), type: "string" },
          { id: "5", name: "ports", value: expr('={{ $("Cost Estimator").item.json.ports }}'), type: "string" },
          { id: "6", name: "memoryMB", value: expr('={{ $("Cost Estimator").item.json.memoryMB }}'), type: "number" },
          { id: "7", name: "cpuCores", value: expr('={{ $("Cost Estimator").item.json.cpuCores }}'), type: "number" },
          { id: "8", name: "architecture", value: expr('={{ $("Cost Estimator").item.json.architecture }}'), type: "string" },
          { id: "9", name: "plan", value: expr('={{ $("Extract Final Decision").item.json.plan || "" }}'), type: "string" },
          { id: "10", name: "forgeProvisionerUrl", value: expr('={{ $("Cost Estimator").item.json.forgeProvisionerUrl }}'), type: "string" },
        ],
      },
      options: {},
    },
    position: [3968, 96],
  },
  output: [{ deploymentId: 42, provider: "aws", dockerImageUrl: "nginx:latest", runtime: "static", ports: "80", memoryMB: 512, cpuCores: 0.25, architecture: "AWS ECS Fargate", plan: "", forgeProvisionerUrl: "" }],
});

const updateStatusApproved = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Update Status Approved",
    parameters: {
      operation: "executeQuery",
      query: expr("=UPDATE deployments SET status = 'deploying', provider = '{{ $json.provider }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $json.deploymentId }}"),
      options: {},
    },
    position: [4192, 96],
  },
  output: [{ success: true }],
});

const updateStatusRejected = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Update Status Rejected",
    parameters: {
      operation: "executeQuery",
      query: expr("=UPDATE deployments SET status = 'rejected', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $(\"Save Deployment Request\").item.json.id }}"),
      options: {},
    },
    position: [3744, 384],
  },
  output: [{ success: true }],
});

// ---------- Chat loop ------------------------------------------------------
const buildChatHistory = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "Build Chat History",
    parameters: {
      jsCode: "const body = $input.first().json.body || {};\nconst history = Array.isArray(body.history) ? body.history.slice() : [];\nconst userMessage = body.message || \"\";\nhistory.push({ role: \"user\", content: userMessage });\nreturn [{ json: { history, userMessage } }];",
    },
    position: [2944, 576],
  },
  output: [{ history: [{ role: "user", content: "hello" }], userMessage: "hello" }],
});

const deploymentChatAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 3.1,
  config: {
    name: "Deployment Chat Agent",
    parameters: {
      promptType: "define",
      text: expr('=Conversation so far:\n{{ $json.history.map(function(m) { return m.role + ": " + m.content; }).join("\n") }}\n\nRespond as the assistant to the latest user message.'),
      options: {
        systemMessage: expr('=You are a cloud deployment advisor for a public Docker Hub to AWS ECS Fargate POC.\n\nDeployment context:\n- Docker image: {{ $("Cost Estimator").item.json.dockerImageUrl }}\n- Recommended architecture: {{ $("Cost Estimator").item.json.architecture }}\n- Runtime: {{ $("Cost Estimator").item.json.runtime }}\n- Ports: {{ $("Cost Estimator").item.json.ports }}\n- Memory: {{ $("Cost Estimator").item.json.memoryMB }} MB\n- CPU: {{ $("Cost Estimator").item.json.cpuCores }} cores\n- Monthly cost estimate: AWS ${{ $("Cost Estimator").item.json.awsCost }}\n\nBe precise about blockers: Forge WEBSITE_URL must be public to n8n, AWS credentials need ECS/EC2/IAM permissions, ECS needs public subnets/security group ingress, and no SSH is used.'),
      },
    },
    subnodes: { model: openAiModel },
    position: [3168, 576],
  },
  output: [{ output: "Hello! I'm here to help with your deployment." }],
});

const appendAiResponse = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    name: "Append AI Response",
    parameters: {
      jsCode: "const agentOutput = $input.first().json.output || \"\";\nconst prev = $(\"Build Chat History\").first().json.history || [];\nconst history = prev.slice();\nhistory.push({ role: \"assistant\", content: agentOutput });\nreturn [{ json: { reply: agentOutput, history } }];",
    },
    position: [3520, 576],
  },
  output: [{ reply: "Hello! I'm here to help.", history: [{ role: "user", content: "hello" }, { role: "assistant", content: "Hello! I'm here to help." }] }],
});

const respondChatReply = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.5,
  config: {
    name: "Respond Chat Reply",
    parameters: {
      respondWith: "json",
      responseBody: expr('={\n  "type": "chat",\n  "reply": {{ JSON.stringify($json.reply) }},\n  "history": {{ JSON.stringify($json.history) }},\n  "resumeUrl": "{{ $execution.resumeUrl }}",\n  "deploymentId": {{ $("Save Deployment Request").item.json.id }}\n}'),
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Content-Type", value: "application/json" },
          ],
        },
      },
    },
    position: [3744, 648],
  },
  output: [{ type: "chat", reply: "Hello!", history: [], resumeUrl: "https://example.com/resume", deploymentId: 42 }],
});

// ---------- Monitoring loop ------------------------------------------------
const fetchActiveDeployments = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Fetch Active Deployments",
    parameters: {
      operation: "executeQuery",
      query: "SELECT id, deployment_url FROM deployments WHERE status = 'deployed' AND health_status = 'healthy'",
      options: {},
    },
    position: [224, 872],
  },
  output: [{ id: 1, deployment_url: "https://example.com" }],
});

const monitorHealth = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.4,
  config: {
    name: "Monitor Health",
    parameters: {
      url: expr('={{ $json.deployment_url }}'),
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 10000 },
    },
    position: [448, 872],
  },
  output: [{ statusCode: 200 }],
});

const checkMonitorStatus = ifElse({
  version: 2.3,
  config: {
    name: "Check Monitor Status",
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 1 },
        conditions: [
          { id: "1", leftValue: expr('={{ $json.statusCode }}'), rightValue: 200, operator: { type: "number", operation: "notEquals" } },
        ],
      },
      options: {},
    },
    position: [672, 872],
  },
});

const markDeploymentUnhealthy = node({
  type: "n8n-nodes-base.postgres",
  version: 2.6,
  config: {
    name: "Mark Deployment Unhealthy",
    parameters: {
      operation: "executeQuery",
      query: expr("=UPDATE deployments SET health_status = 'unhealthy', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $(\"Fetch Active Deployments\").item.json.id }}"),
      options: {},
    },
    position: [896, 872],
  },
  output: [{ success: true }],
});

// ---------- Compose workflow -----------------------------------------------
export default workflow("Co7HN1Zf7FQT6YSa", "Agentic IDP — Brain-only Pipeline")
  .add(deploymentWebhook)
  .to(normalizeInput)
  .to(fetchDockerImageMetadata)
  .to(composeAppSpec)
  .to(analyzerAgent)
  .to(flattenAnalyzerOutput)
  .to(architectAgent)
  .to(costEstimator)
  .to(saveDeploymentRequest)
  .to(respondToFrontend)
  .to(chatWait)
  .to(isFinalDecision
    .onTrue(extractFinalDecision
      .to(respondFinalDecision)
      .to(checkFinalApproval
        .onTrue(captureApproval.to(updateStatusApproved))
        .onFalse(updateStatusRejected)))
    .onFalse(buildChatHistory
      .to(deploymentChatAgent)
      .to(appendAiResponse)
      .to(respondChatReply)
      .to(chatWait)))
  .add(monitoringSchedule)
  .to(fetchActiveDeployments)
  .to(monitorHealth)
  .to(checkMonitorStatus.onTrue(markDeploymentUnhealthy));
