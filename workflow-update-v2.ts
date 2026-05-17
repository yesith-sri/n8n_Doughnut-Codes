import {
  workflow,
  node,
  trigger,
  ifElse,
  switchCase,
  merge,
  languageModel,
  expr,
  newCredential,
  placeholder
} from '@n8n/workflow-sdk';

/* ------------------------------------------------------------------ */
/*  Subnode definitions                                                */
/* ------------------------------------------------------------------ */
const openAiGpt4 = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI GPT-4.1',
    parameters: {},
    credentials: { openAiApi: newCredential('OpenAI') },
    position: [976, 576]
  }
});

/* ------------------------------------------------------------------ */
/*  Trigger & early pipeline                                           */
/* ------------------------------------------------------------------ */
const deploymentWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Deployment Webhook',
    parameters: {
      path: 'deploy',
      httpMethod: 'POST',
      responseMode: 'responseNode'
    },
    position: [0, 464]
  },
  output: [{ body: { dockerImageUrl: 'nginx:latest' } }]
});

const normalizeInput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Normalize Input',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'dockerImageUrl', value: expr("{{ $json.body.dockerImageUrl || '' }}"), type: 'string' },
          { id: '2', name: 'dockerfileContent', value: expr("{{ $json.body.dockerfileContent || '' }}"), type: 'string' }
        ]
      }
    },
    position: [224, 464]
  },
  output: [{ dockerImageUrl: 'nginx:latest', dockerfileContent: '' }]
});

const fetchDockerImageMetadata = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Docker Image Metadata',
    parameters: {
      method: 'GET',
      url: expr("https://hub.docker.com/v2/repositories/library/{{ $json.dockerImageUrl.split(':')[0] }}/tags/{{ $json.dockerImageUrl.split(':')[1] || 'latest' }}"),
      options: {
        response: { response: { fullResponse: true, neverError: true } },
        timeout: 15000
      }
    },
    position: [448, 464]
  },
  output: [{ statusCode: 200, body: { name: 'latest', full_size: 25000000 } }]
});

const composeAppSpec = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Compose App Spec',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '2', name: 'imageSizeBytes', value: expr('{{ $json.body.full_size || 0 }}'), type: 'number' }
        ]
      }
    },
    position: [672, 464]
  },
  output: [{ dockerImageUrl: 'nginx:latest', imageSizeBytes: 25000000 }]
});

const analyzerAgent = node({
  type: '@n8n/n8n-nodes-langchain.informationExtractor',
  version: 1.2,
  config: {
    name: 'Analyzer Agent',
    parameters: {
      text: expr('{{ $json.dockerImageUrl }}'),
      schemaType: 'fromAttributes',
      attributes: {
        attributes: [
          { name: 'runtime', type: 'string', description: 'Detected runtime (node, python, go, java, static, etc.)', required: true },
          { name: 'ports', type: 'string', description: 'Comma-separated exposed ports', required: true },
          { name: 'estimatedMemoryMB', type: 'number', description: 'Estimated memory in MB', required: true },
          { name: 'estimatedCPU', type: 'number', description: 'Estimated CPU cores', required: true }
        ]
      },
      options: { systemPromptTemplate: 'You are a Docker image analyst. Inspect the image name and infer runtime, ports, memory, and CPU requirements. Return structured data only.' }
    },
    subnodes: { model: openAiGpt4 },
    position: [896, 352]
  },
  output: [{ runtime: 'static', ports: '80', estimatedMemoryMB: 256, estimatedCPU: 0.25 }]
});

const architectAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Architect Agent',
    parameters: {
      promptType: 'define',
      text: expr('Recommend the best cloud provider and architecture for {{ $json.dockerImageUrl }} (runtime: {{ $json.runtime }}, ports: {{ $json.ports }}, memory: {{ $json.estimatedMemoryMB }}MB, CPU: {{ $json.estimatedCPU }}). Return a concise architecture recommendation.'),
      options: { systemMessage: 'You are a cloud architect. Recommend AWS, GCP, or Azure with a brief justification.' }
    },
    subnodes: { model: openAiGpt4 },
    position: [1248, 464]
  },
  output: [{ output: 'GCP Cloud Run is recommended for this stateless container.' }]
});

const costEstimator = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Cost Estimator',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'architecture', value: expr('{{ $json.output }}'), type: 'string' },
          { id: '2', name: 'runtime', value: expr("{{ $('Analyzer Agent').item.json.runtime }}"), type: 'string' },
          { id: '3', name: 'ports', value: expr("{{ $('Analyzer Agent').item.json.ports }}"), type: 'string' },
          { id: '4', name: 'memoryMB', value: expr("{{ $('Analyzer Agent').item.json.estimatedMemoryMB }}"), type: 'number' },
          { id: '5', name: 'cpuCores', value: expr("{{ $('Analyzer Agent').item.json.estimatedCPU }}"), type: 'number' },
          { id: '6', name: 'awsCost', value: expr('{{ Math.round(38 + ($("Analyzer Agent").item.json.estimatedMemoryMB / 512) * 5 * ($("Analyzer Agent").item.json.estimatedCPU || 0.5)) }}'), type: 'number' },
          { id: '7', name: 'gcpCost', value: expr('{{ Math.round(28 + ($("Analyzer Agent").item.json.estimatedMemoryMB / 512) * 4 * ($("Analyzer Agent").item.json.estimatedCPU || 0.5)) }}'), type: 'number' },
          { id: '8', name: 'azureCost', value: expr('{{ Math.round(41 + ($("Analyzer Agent").item.json.estimatedMemoryMB / 512) * 5.3 * ($("Analyzer Agent").item.json.estimatedCPU || 0.5)) }}'), type: 'number' },
          { id: '9', name: 'dockerImageUrl', value: expr("{{ $('Compose App Spec').item.json.dockerImageUrl }}"), type: 'string' },
          { id: '10', name: 'recommendedProvider', value: expr("{{ $json.output.toLowerCase().includes('gcp') ? 'gcp' : ($json.output.toLowerCase().includes('azure') ? 'azure' : 'aws') }}"), type: 'string' }
        ]
      }
    },
    position: [1600, 464]
  },
  output: [{ architecture: 'GCP Cloud Run', runtime: 'static', ports: '80', memoryMB: 256, cpuCores: 0.25, awsCost: 40, gcpCost: 30, azureCost: 43, dockerImageUrl: 'nginx:latest', recommendedProvider: 'gcp' }]
});

const saveDeploymentRequest = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Deployment Request',
    parameters: {
      operation: 'executeQuery',
      query: expr("INSERT INTO deployments (status, runtime, ports, architecture, docker_image_url, aws_cost, gcp_cost, azure_cost, created_at, updated_at) VALUES ('pending_approval', '{{ $json.runtime }}', '{{ $json.ports }}', '{{ $json.architecture }}', '{{ $json.dockerImageUrl }}', {{ $json.awsCost }}, {{ $json.gcpCost }}, {{ $json.azureCost }}, '{{ $now.toISO() }}', '{{ $now.toISO() }}') RETURNING id, status, architecture, docker_image_url, aws_cost, gcp_cost, azure_cost")
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [1824, 464]
  },
  output: [{ id: 42, status: 'pending_approval', architecture: 'GCP Cloud Run', docker_image_url: 'nginx:latest', aws_cost: 40, gcp_cost: 30, azure_cost: 43 }]
});

const respondToFrontend = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Frontend',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{\n  "deploymentId": {{ $json.id }},\n  "status": "pending_approval",\n  "architecture": "{{ $("Cost Estimator").item.json.architecture }}",\n  "recommendedProvider": "{{ $("Cost Estimator").item.json.recommendedProvider }}",\n  "dockerImageUrl": "{{ $("Cost Estimator").item.json.dockerImageUrl }}",\n  "runtime": "{{ $("Cost Estimator").item.json.runtime }}",\n  "ports": "{{ $("Cost Estimator").item.json.ports }}",\n  "memoryMB": {{ $("Cost Estimator").item.json.memoryMB }},\n  "cpuCores": {{ $("Cost Estimator").item.json.cpuCores }},\n  "costs": { "aws": {{ $("Cost Estimator").item.json.awsCost }}, "gcp": {{ $("Cost Estimator").item.json.gcpCost }}, "azure": {{ $("Cost Estimator").item.json.azureCost }} },\n  "resumeUrl": "{{ $execution.resumeUrl }}"\n}'),
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Content-Type', value: 'application/json' }
          ]
        }
      }
    },
    position: [2048, 464]
  },
  output: [{ deploymentId: 42, status: 'pending_approval' }]
});

const chatWait = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Chat Wait',
    parameters: {
      resume: 'webhook',
      options: { responseMode: 'responseNode' }
    },
    position: [2272, 464]
  },
  output: [{ body: { type: 'chat', message: 'what is the cheapest?' } }]
});

const isFinalDecision = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Is Final Decision?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { id: '1', leftValue: expr("{{ $json.body.type }}"), rightValue: 'final', operator: { type: 'string', operation: 'equals' } }
        ]
      }
    },
    position: [2496, 384]
  }
});

const extractFinalDecision = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extract Final Decision',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'action', value: expr("{{ $json.body.action }}"), type: 'string' },
          { id: '2', name: 'provider', value: expr("{{ $json.body.provider || $('Cost Estimator').item.json.recommendedProvider }}"), type: 'string' },
          { id: '3', name: 'plan', value: expr("{{ $json.body.plan || '' }}"), type: 'string' }
        ]
      }
    },
    position: [2720, 288]
  },
  output: [{ action: 'approve', provider: 'gcp', plan: '' }]
});

const respondFinalDecision = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Final Decision',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{\n  "type": "final",\n  "status": "deploying",\n  "action": "{{ $json.action }}",\n  "provider": "{{ $json.provider }}",\n  "plan": "{{ $json.plan }}"\n}'),
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Content-Type', value: 'application/json' }
          ]
        }
      }
    },
    position: [3008, 288]
  },
  output: [{ type: 'final', status: 'deploying', action: 'approve', provider: 'gcp' }]
});

const checkFinalApproval = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Check Final Approval',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { id: '1', leftValue: expr("{{ $json.action }}"), rightValue: 'approve', operator: { type: 'string', operation: 'equals' } }
        ]
      }
    },
    position: [3296, 288]
  }
});

const captureApproval = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Capture Approval',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'deploymentId', value: expr("{{ $('Save Deployment Request').item.json.id }}"), type: 'number' },
          { id: '2', name: 'provider', value: expr("{{ $json.provider || $('Cost Estimator').item.json.recommendedProvider }}"), type: 'string' },
          { id: '3', name: 'dockerImageUrl', value: expr("{{ $('Cost Estimator').item.json.dockerImageUrl }}"), type: 'string' },
          { id: '4', name: 'runtime', value: expr("{{ $('Cost Estimator').item.json.runtime }}"), type: 'string' },
          { id: '5', name: 'ports', value: expr("{{ $('Cost Estimator').item.json.ports }}"), type: 'string' },
          { id: '6', name: 'memoryMB', value: expr("{{ $('Cost Estimator').item.json.memoryMB }}"), type: 'number' },
          { id: '7', name: 'cpuCores', value: expr("{{ $('Cost Estimator').item.json.cpuCores }}"), type: 'number' },
          { id: '8', name: 'architecture', value: expr("{{ $('Cost Estimator').item.json.architecture }}"), type: 'string' },
          { id: '9', name: 'plan', value: expr("{{ $('Extract Final Decision').item.json.plan || '' }}"), type: 'string' }
        ]
      }
    },
    position: [3520, 96]
  },
  output: [{ deploymentId: 42, provider: 'gcp', dockerImageUrl: 'nginx:latest', runtime: 'static', ports: '80', memoryMB: 256, cpuCores: 0.25, architecture: 'GCP Cloud Run', plan: '' }]
});

const updateStatusApproved = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Status Approved',
    parameters: {
      operation: 'executeQuery',
      query: expr("UPDATE deployments SET status = 'approved', provider = '{{ $json.provider }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $json.deploymentId }}")
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [3744, 96]
  },
  output: [{ success: true }]
});

/* ------------------------------------------------------------------ */
/*  NEW: Bastion-based VM deployment section                           */
/* ------------------------------------------------------------------ */
const prepareBastionDeploy = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Prepare Bastion Deploy',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '2', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'memoryMB', value: expr('{{ $json.memoryMB }}'), type: 'number' },
          { id: '5', name: 'cpuCores', value: expr('{{ $json.cpuCores }}'), type: 'number' },
          { id: '6', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '7', name: 'runtime', value: expr('{{ $json.runtime }}'), type: 'string' },
          { id: '8', name: 'region', value: expr("{{ $json.provider === 'aws' ? 'us-east-1' : ($json.provider === 'gcp' ? 'us-central1' : 'eastus') }}"), type: 'string' },
          { id: '9', name: 'projectName', value: expr("{{ $json.dockerImageUrl.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 40).toLowerCase() }}"), type: 'string' },
          { id: '10', name: 'terminalHistory', value: expr("{{ '' }}"), type: 'string' }
        ]
      }
    },
    position: [3968, 96]
  },
  output: [{ provider: 'gcp', dockerImageUrl: 'nginx:latest', deploymentId: 42, memoryMB: 256, cpuCores: 0.25, ports: '80', runtime: 'static', region: 'us-central1', projectName: 'nginx-latest', terminalHistory: '' }]
});

const routeByProvider = switchCase({
  type: 'n8n-nodes-base.switch',
  version: 3.4,
  config: {
    name: 'Route by Provider',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { id: '1', leftValue: expr('{{ $json.provider }}'), rightValue: 'aws', operator: { type: 'string', operation: 'equals' } }
              ],
              combinator: 'and'
            }
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { id: '2', leftValue: expr('{{ $json.provider }}'), rightValue: 'gcp', operator: { type: 'string', operation: 'equals' } }
              ],
              combinator: 'and'
            }
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { id: '3', leftValue: expr('{{ $json.provider }}'), rightValue: 'azure', operator: { type: 'string', operation: 'equals' } }
              ],
              combinator: 'and'
            }
          }
        ]
      }
    },
    position: [4200, 80]
  }
});

/* -- AWS branch -- */
const prepareAwsBastionDeploy = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Prepare AWS Bastion Deploy',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'deployCommand', value: expr('{{ "export DOCKER_IMAGE=\"" + $json.dockerImageUrl + "\"; export PROVIDER=aws; export REGION=" + $json.region + "; export PROJECT_NAME=" + $json.projectName + "; export PORT=" + $json.ports + "; export MEMORY_MB=" + $json.memoryMB + "; export CPU_LIMIT=" + $json.cpuCores + "; export DEPLOYMENT_ID=" + $json.deploymentId + "; /opt/bastion/deploy.sh" }}'), type: 'string' },
          { id: '2', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '5', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '6', name: 'terminalHistory', value: expr('{{ $json.terminalHistory }}'), type: 'string' }
        ]
      }
    },
    position: [4480, 0]
  },
  output: [{ deployCommand: 'export DOCKER_IMAGE="nginx:latest"; export PROVIDER=aws; export REGION=us-east-1; export PROJECT_NAME=nginx-latest; export PORT=80; export MEMORY_MB=256; export CPU_LIMIT=0.25; export DEPLOYMENT_ID=42; /opt/bastion/deploy.sh', provider: 'aws', deploymentId: 42, dockerImageUrl: 'nginx:latest', ports: '80', terminalHistory: '' }]
});

const sshBastionAwsDeploy = node({
  type: 'n8n-nodes-base.ssh',
  version: 1,
  config: {
    name: 'SSH Bastion AWS Deploy',
    parameters: {
      resource: 'command',
      operation: 'execute',
      command: expr('{{ $json.deployCommand }}')
    },
    credentials: { sshPassword: newCredential('Bastion Host') },
    position: [4700, 0]
  },
  output: [{ code: 0, signal: null, stdout: '{"success":true,"targetIp":"1.2.3.4","message":"AWS deploy ok"}', stderr: '' }]
});

const parseAwsResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse AWS Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const input = $input.first().json;\nlet parsed = {};\ntry {\n  const lines = (input.stdout || '').split('\n').filter(l => l.trim());\n  const lastLine = lines[lines.length - 1] || '{}';\n  parsed = JSON.parse(lastLine);\n} catch (e) {\n  parsed = { success: false, error: 'Failed to parse deploy output: ' + (input.stdout || '') };\n}\nconst prevHistory = input.terminalHistory || '';\nconst newHistory = prevHistory + '\n\n[' + new Date().toISOString() + '] AWS Deploy via Bastion:\nstdout: ' + (input.stdout || '') + '\nstderr: ' + (input.stderr || '');\nreturn [{ json: {\n  ...input,\n  deploySuccess: parsed.success === true,\n  targetIp: parsed.targetIp || '',\n  deployMessage: parsed.message || '',\n  terminalHistory: newHistory\n} }];"
    },
    position: [4920, 0]
  },
  output: [{ deploySuccess: true, targetIp: '1.2.3.4', deployMessage: 'AWS deploy ok', terminalHistory: '\n\n[2026-05-17T10:00:00.000Z] AWS Deploy via Bastion:\nstdout: {\"success\":true,\"targetIp\":\"1.2.3.4\",\"message\":\"AWS deploy ok\"}\nstderr: ', provider: 'aws', deploymentId: 42 }]
});

const checkAwsSuccess = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Check AWS Success',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          { id: '1', leftValue: expr('{{ $json.deploySuccess }}'), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }
        ]
      }
    },
    position: [5140, 0]
  }
});

const extractAwsTargetIp = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extract AWS Target IP',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'targetIp', value: expr('{{ $json.targetIp }}'), type: 'string' },
          { id: '2', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '5', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '6', name: 'terminalHistory', value: expr('{{ $json.terminalHistory }}'), type: 'string' },
          { id: '7', name: 'healthCheckCommand', value: expr("{{ 'export TARGET_IP=' + $json.targetIp + '; export APP_PORT=' + $json.ports + '; /opt/bastion/health-check.sh' }}"), type: 'string' }
        ]
      }
    },
    position: [5360, 0]
  },
  output: [{ targetIp: '1.2.3.4', provider: 'aws', deploymentId: 42, dockerImageUrl: 'nginx:latest', ports: '80', terminalHistory: '', healthCheckCommand: 'export TARGET_IP=1.2.3.4; export APP_PORT=80; /opt/bastion/health-check.sh' }]
});

/* -- GCP branch -- */
const prepareGcpBastionDeploy = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Prepare GCP Bastion Deploy',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'deployCommand', value: expr('{{ "export DOCKER_IMAGE=\"" + $json.dockerImageUrl + "\"; export PROVIDER=gcp; export REGION=" + $json.region + "; export PROJECT_NAME=" + $json.projectName + "; export PORT=" + $json.ports + "; export MEMORY_MB=" + $json.memoryMB + "; export CPU_LIMIT=" + $json.cpuCores + "; export DEPLOYMENT_ID=" + $json.deploymentId + "; /opt/bastion/deploy.sh" }}'), type: 'string' },
          { id: '2', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '5', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '6', name: 'terminalHistory', value: expr('{{ $json.terminalHistory }}'), type: 'string' }
        ]
      }
    },
    position: [4480, 200]
  },
  output: [{ deployCommand: 'export DOCKER_IMAGE="nginx:latest"; export PROVIDER=gcp; export REGION=us-central1; export PROJECT_NAME=nginx-latest; export PORT=80; export MEMORY_MB=256; export CPU_LIMIT=0.25; export DEPLOYMENT_ID=42; /opt/bastion/deploy.sh', provider: 'gcp', deploymentId: 42, dockerImageUrl: 'nginx:latest', ports: '80', terminalHistory: '' }]
});

const sshBastionGcpDeploy = node({
  type: 'n8n-nodes-base.ssh',
  version: 1,
  config: {
    name: 'SSH Bastion GCP Deploy',
    parameters: {
      resource: 'command',
      operation: 'execute',
      command: expr('{{ $json.deployCommand }}')
    },
    credentials: { sshPassword: newCredential('Bastion Host') },
    position: [4700, 200]
  },
  output: [{ code: 0, signal: null, stdout: '{"success":true,"targetIp":"5.6.7.8","message":"GCP deploy ok"}', stderr: '' }]
});

const parseGcpResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse GCP Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const input = $input.first().json;\nlet parsed = {};\ntry {\n  const lines = (input.stdout || '').split('\n').filter(l => l.trim());\n  const lastLine = lines[lines.length - 1] || '{}';\n  parsed = JSON.parse(lastLine);\n} catch (e) {\n  parsed = { success: false, error: 'Failed to parse deploy output: ' + (input.stdout || '') };\n}\nconst prevHistory = input.terminalHistory || '';\nconst newHistory = prevHistory + '\n\n[' + new Date().toISOString() + '] GCP Deploy via Bastion:\nstdout: ' + (input.stdout || '') + '\nstderr: ' + (input.stderr || '');\nreturn [{ json: {\n  ...input,\n  deploySuccess: parsed.success === true,\n  targetIp: parsed.targetIp || '',\n  deployMessage: parsed.message || '',\n  terminalHistory: newHistory\n} }];"
    },
    position: [4920, 200]
  },
  output: [{ deploySuccess: true, targetIp: '5.6.7.8', deployMessage: 'GCP deploy ok', terminalHistory: '\n\n[2026-05-17T10:00:00.000Z] GCP Deploy via Bastion:\nstdout: {\"success\":true,\"targetIp\":\"5.6.7.8\",\"message\":\"GCP deploy ok\"}\nstderr: ', provider: 'gcp', deploymentId: 42 }]
});

const checkGcpSuccess = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Check GCP Success',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          { id: '1', leftValue: expr('{{ $json.deploySuccess }}'), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }
        ]
      }
    },
    position: [5140, 200]
  }
});

const extractGcpTargetIp = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extract GCP Target IP',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'targetIp', value: expr('{{ $json.targetIp }}'), type: 'string' },
          { id: '2', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '5', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '6', name: 'terminalHistory', value: expr('{{ $json.terminalHistory }}'), type: 'string' },
          { id: '7', name: 'healthCheckCommand', value: expr("{{ 'export TARGET_IP=' + $json.targetIp + '; export APP_PORT=' + $json.ports + '; /opt/bastion/health-check.sh' }}"), type: 'string' }
        ]
      }
    },
    position: [5360, 200]
  },
  output: [{ targetIp: '5.6.7.8', provider: 'gcp', deploymentId: 42, dockerImageUrl: 'nginx:latest', ports: '80', terminalHistory: '', healthCheckCommand: 'export TARGET_IP=5.6.7.8; export APP_PORT=80; /opt/bastion/health-check.sh' }]
});

/* -- Azure branch -- */
const prepareAzureBastionDeploy = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Prepare Azure Bastion Deploy',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'deployCommand', value: expr('{{ "export DOCKER_IMAGE=\"" + $json.dockerImageUrl + "\"; export PROVIDER=azure; export REGION=" + $json.region + "; export PROJECT_NAME=" + $json.projectName + "; export PORT=" + $json.ports + "; export MEMORY_MB=" + $json.memoryMB + "; export CPU_LIMIT=" + $json.cpuCores + "; export DEPLOYMENT_ID=" + $json.deploymentId + "; /opt/bastion/deploy.sh" }}'), type: 'string' },
          { id: '2', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '5', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '6', name: 'terminalHistory', value: expr('{{ $json.terminalHistory }}'), type: 'string' }
        ]
      }
    },
    position: [4480, 400]
  },
  output: [{ deployCommand: 'export DOCKER_IMAGE="nginx:latest"; export PROVIDER=azure; export REGION=eastus; export PROJECT_NAME=nginx-latest; export PORT=80; export MEMORY_MB=256; export CPU_LIMIT=0.25; export DEPLOYMENT_ID=42; /opt/bastion/deploy.sh', provider: 'azure', deploymentId: 42, dockerImageUrl: 'nginx:latest', ports: '80', terminalHistory: '' }]
});

const sshBastionAzureDeploy = node({
  type: 'n8n-nodes-base.ssh',
  version: 1,
  config: {
    name: 'SSH Bastion Azure Deploy',
    parameters: {
      resource: 'command',
      operation: 'execute',
      command: expr('{{ $json.deployCommand }}')
    },
    credentials: { sshPassword: newCredential('Bastion Host') },
    position: [4700, 400]
  },
  output: [{ code: 0, signal: null, stdout: '{"success":true,"targetIp":"9.10.11.12","message":"Azure deploy ok"}', stderr: '' }]
});

const parseAzureResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Azure Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const input = $input.first().json;\nlet parsed = {};\ntry {\n  const lines = (input.stdout || '').split('\n').filter(l => l.trim());\n  const lastLine = lines[lines.length - 1] || '{}';\n  parsed = JSON.parse(lastLine);\n} catch (e) {\n  parsed = { success: false, error: 'Failed to parse deploy output: ' + (input.stdout || '') };\n}\nconst prevHistory = input.terminalHistory || '';\nconst newHistory = prevHistory + '\n\n[' + new Date().toISOString() + '] Azure Deploy via Bastion:\nstdout: ' + (input.stdout || '') + '\nstderr: ' + (input.stderr || '');\nreturn [{ json: {\n  ...input,\n  deploySuccess: parsed.success === true,\n  targetIp: parsed.targetIp || '',\n  deployMessage: parsed.message || '',\n  terminalHistory: newHistory\n} }];"
    },
    position: [4920, 400]
  },
  output: [{ deploySuccess: true, targetIp: '9.10.11.12', deployMessage: 'Azure deploy ok', terminalHistory: '\n\n[2026-05-17T10:00:00.000Z] Azure Deploy via Bastion:\nstdout: {\"success\":true,\"targetIp\":\"9.10.11.12\",\"message\":\"Azure deploy ok\"}\nstderr: ', provider: 'azure', deploymentId: 42 }]
});

const checkAzureSuccess = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Check Azure Success',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          { id: '1', leftValue: expr('{{ $json.deploySuccess }}'), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }
        ]
      }
    },
    position: [5140, 400]
  }
});

const extractAzureTargetIp = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extract Azure Target IP',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: '1', name: 'targetIp', value: expr('{{ $json.targetIp }}'), type: 'string' },
          { id: '2', name: 'provider', value: expr('{{ $json.provider }}'), type: 'string' },
          { id: '3', name: 'deploymentId', value: expr('{{ $json.deploymentId }}'), type: 'number' },
          { id: '4', name: 'dockerImageUrl', value: expr('{{ $json.dockerImageUrl }}'), type: 'string' },
          { id: '5', name: 'ports', value: expr('{{ $json.ports }}'), type: 'string' },
          { id: '6', name: 'terminalHistory', value: expr('{{ $json.terminalHistory }}'), type: 'string' },
          { id: '7', name: 'healthCheckCommand', value: expr("{{ 'export TARGET_IP=' + $json.targetIp + '; export APP_PORT=' + $json.ports + '; /opt/bastion/health-check.sh' }}"), type: 'string' }
        ]
      }
    },
    position: [5360, 400]
  },
  output: [{ targetIp: '9.10.11.12', provider: 'azure', deploymentId: 42, dockerImageUrl: 'nginx:latest', ports: '80', terminalHistory: '', healthCheckCommand: 'export TARGET_IP=9.10.11.12; export APP_PORT=80; /opt/bastion/health-check.sh' }]
});

/* -- Convergence: health check via bastion -- */
const sshBastionHealthCheck = node({
  type: 'n8n-nodes-base.ssh',
  version: 1,
  config: {
    name: 'SSH Bastion Health Check',
    parameters: {
      resource: 'command',
      operation: 'execute',
      command: expr('{{ $json.healthCheckCommand }}')
    },
    credentials: { sshPassword: newCredential('Bastion Host') },
    position: [5600, 200]
  },
  output: [{ code: 0, signal: null, stdout: '{"healthy":true,"metrics":{"cpu_usage":0.15,"memory_available_percent":78.5,"load_average":0.32,"disk_free_percent":85.2},"app_status":"running","app_http_status":200}', stderr: '' }]
});

const parseHealthResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Health Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const input = $input.first().json;\nlet parsed = {};\ntry {\n  const lines = (input.stdout || '').split('\n').filter(l => l.trim());\n  const lastLine = lines[lines.length - 1] || '{}';\n  parsed = JSON.parse(lastLine);\n} catch (e) {\n  parsed = { healthy: false, error: 'Failed to parse health check output: ' + (input.stdout || '') };\n}\nconst prevHistory = input.terminalHistory || '';\nconst newHistory = prevHistory + '\n\n[' + new Date().toISOString() + '] Health Check via Bastion:\nstdout: ' + (input.stdout || '') + '\nstderr: ' + (input.stderr || '');\nconst healthy = parsed.healthy === true && parsed.app_status === 'running';\nconst deploymentUrl = 'http://' + (input.targetIp || '') + ':' + (input.ports || '80');\nreturn [{ json: {\n  statusCode: healthy ? 200 : 500,\n  deploymentUrl: deploymentUrl,\n  deploymentId: input.deploymentId,\n  provider: input.provider,\n  healthy: healthy,\n  metrics: parsed.metrics || {},\n  appStatus: parsed.app_status || 'unknown',\n  appHttpStatus: parsed.app_http_status || 0,\n  terminalHistory: newHistory\n} }];"
    },
    position: [5820, 200]
  },
  output: [{ statusCode: 200, deploymentUrl: 'http://1.2.3.4:80', deploymentId: 42, provider: 'aws', healthy: true, metrics: { cpu_usage: 0.15, memory_available_percent: 78.5, load_average: 0.32, disk_free_percent: 85.2 }, appStatus: 'running', appHttpStatus: 200, terminalHistory: '' }]
});

const checkHealthStatus = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Check Health Status',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { id: '1', leftValue: expr('{{ $json.healthy }}'), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }
        ]
      }
    },
    position: [6040, 200]
  }
});

const updateStatusSuccess = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Status Success',
    parameters: {
      operation: 'executeQuery',
      query: expr("UPDATE deployments SET status = 'deployed', health_status = 'healthy', deployment_url = '{{ $json.deploymentUrl }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $json.deploymentId }}")
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [6260, 200]
  },
  output: [{ success: true }]
});

const debuggerAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Debugger Agent',
    parameters: {
      promptType: 'define',
      text: expr('A deployment health check returned status {{ $json.healthy ? \'HEALTHY\' : \'UNHEALTHY\' }} for a {{ $json.provider }} deployment (ID: {{ $json.deploymentId }}, URL: {{ $json.deploymentUrl }}).\\n\\nTerminal history:\\n{{ $json.terminalHistory }}\\n\\nMetrics: {{ JSON.stringify($json.metrics) }}\\n\\nReturn ONLY raw JSON, no markdown:\\n{\\n  "rootCause": "specific description of likely failure",\\n  "suggestedFix": "concrete corrective action",\\n  "shouldRetry": true\\n}'),
      options: { systemMessage: 'You are a deployment incident-response engineer. Analyze deployment failures and produce actionable JSON recommendations. Consider: container startup errors, missing env vars, port mismatches, cold-start timeouts, permission issues.' }
    },
    subnodes: { model: openAiGpt4 },
    position: [6260, 400]
  },
  output: [{ output: '{"rootCause":"node_exporter not yet ready","suggestedFix":"Wait 30s and retry","shouldRetry":true}' }]
});

const updateStatusFailed = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Status Failed',
    parameters: {
      operation: 'executeQuery',
      query: expr("UPDATE deployments SET status = 'failed', health_status = 'unhealthy', error_log = '{{ JSON.stringify($json.output).replaceAll("'", "''") }}', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $json.deploymentId }}")
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [6500, 400]
  },
  output: [{ success: true }]
});

/* ------------------------------------------------------------------ */
/*  Chat loop                                                          */
/* ------------------------------------------------------------------ */
const updateStatusRejected = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Status Rejected',
    parameters: {
      operation: 'executeQuery',
      query: expr("UPDATE deployments SET status = 'rejected', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $('Save Deployment Request').item.json.id }}")
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [3520, 288]
  },
  output: [{ success: true }]
});

const buildChatHistory = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Chat History',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const body = $input.first().json.body || {};
const history = Array.isArray(body.history) ? body.history.slice() : [];
const userMessage = body.message || '';
history.push({ role: 'user', content: userMessage });
return [{ json: { history, userMessage } }];"
    },
    position: [2720, 480]
  },
  output: [{ history: [{ role: 'user', content: 'what is the cheapest?' }], userMessage: 'what is the cheapest?' }]
});

const deploymentChatAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Deployment Chat Agent',
    parameters: {
      promptType: 'define',
      text: expr('Conversation so far:\n{{ $json.history.map(function(m) { return m.role + ": " + m.content; }).join("\n") }}\n\nRespond as the assistant to the latest user message.'),
      options: { systemMessage: expr('You are a cloud deployment advisor.\\n\\nDeployment context:\\n- Docker image: {{ $(\'Cost Estimator\').item.json.dockerImageUrl }}\n- Recommended architecture: {{ $(\'Cost Estimator\').item.json.architecture }}\n- Runtime: {{ $(\'Cost Estimator\').item.json.runtime }}\n- Ports: {{ $(\'Cost Estimator\').item.json.ports }}\n- Memory: {{ $(\'Cost Estimator\').item.json.memoryMB }} MB\n- CPU: {{ $(\'Cost Estimator\').item.json.cpuCores }} cores\n- Monthly costs: AWS ${{ $(\'Cost Estimator\').item.json.awsCost }}, GCP ${{ $(\'Cost Estimator\').item.json.gcpCost }}, Azure ${{ $(\'Cost Estimator\').item.json.azureCost }}\n\nHelp the user understand tradeoffs. When ready to commit, they send action (approve/reject) and provider (aws/gcp/azure). Keep responses concise and technical.') }
    },
    subnodes: { model: openAiGpt4 },
    position: [2944, 480]
  },
  output: [{ output: 'GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container.' }]
});

const appendAiResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Append AI Response',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const agentOutput = $input.first().json.output || '';
const prev = $('Build Chat History').first().json.history || [];
const history = prev.slice();
history.push({ role: 'assistant', content: agentOutput });
return [{ json: { reply: agentOutput, history } }];"
    },
    position: [3296, 480]
  },
  output: [{ reply: 'GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container.', history: [{ role: 'user', content: 'what is the cheapest?' }, { role: 'assistant', content: 'GCP Cloud Run is cheapest at $30/mo and a great fit for a stateless container.' }] }]
});

const respondChatReply = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Chat Reply',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{\n  "type": "chat",\n  "reply": {{ JSON.stringify($json.reply) }},\n  "history": {{ JSON.stringify($json.history) }},\n  "resumeUrl": "{{ $execution.resumeUrl }}",\n  "deploymentId": {{ $("Save Deployment Request").item.json.id }}\n}'),
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Content-Type', value: 'application/json' }
          ]
        }
      }
    },
    position: [3520, 624]
  },
  output: [{ type: 'chat', reply: 'GCP Cloud Run is cheapest...', history: [], resumeUrl: 'https://...', deploymentId: 42 }]
});

/* ------------------------------------------------------------------ */
/*  Monitoring branch                                                  */
/* ------------------------------------------------------------------ */
const monitoringSchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Monitoring Schedule',
    parameters: {
      rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] }
    },
    position: [0, 848]
  },
  output: [{}]
});

const fetchActiveDeployments = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Active Deployments',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT id, deployment_url FROM deployments WHERE status = 'deployed' AND health_status = 'healthy'"
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [224, 848]
  },
  output: [{ id: 42, deployment_url: 'http://1.2.3.4:80' }]
});

const monitorHealth = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Monitor Health',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.deployment_url }}'),
      options: {
        response: { response: { fullResponse: true, neverError: true } },
        timeout: 10000
      }
    },
    position: [448, 848]
  },
  output: [{ statusCode: 200, body: 'OK' }]
});

const checkMonitorStatus = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Check Monitor Status',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { id: '1', leftValue: expr('{{ $json.statusCode }}'), rightValue: 200, operator: { type: 'number', operation: 'notEquals' } }
        ]
      }
    },
    position: [672, 848]
  }
});

const markDeploymentUnhealthy = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Mark Deployment Unhealthy',
    parameters: {
      operation: 'executeQuery',
      query: expr("UPDATE deployments SET health_status = 'unhealthy', updated_at = '{{ $now.toISO() }}' WHERE id = {{ $('Fetch Active Deployments').item.json.id }}")
    },
    credentials: { postgres: newCredential('Postgres account') },
    position: [896, 848]
  },
  output: [{ success: true }]
});

/* ------------------------------------------------------------------ */
/*  Workflow builder                                                   */
/* ------------------------------------------------------------------ */
export default workflow('Co7HN1Zf7FQT6YSa', 'Agentic IDP — Self-Healing Deployment Pipeline')
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
  .to(isFinalDecision
    .onTrue(extractFinalDecision
      .to(respondFinalDecision)
      .to(checkFinalApproval
        .onTrue(captureApproval
          .to(updateStatusApproved)
          .to(prepareBastionDeploy)
          .to(routeByProvider
            .onCase(0, prepareAwsBastionDeploy
              .to(sshBastionAwsDeploy)
              .to(parseAwsResult)
              .to(checkAwsSuccess
                .onTrue(extractAwsTargetIp.to(sshBastionHealthCheck))
                .onFalse(debuggerAgent)
              )
            )
            .onCase(1, prepareGcpBastionDeploy
              .to(sshBastionGcpDeploy)
              .to(parseGcpResult)
              .to(checkGcpSuccess
                .onTrue(extractGcpTargetIp.to(sshBastionHealthCheck))
                .onFalse(debuggerAgent)
              )
            )
            .onCase(2, prepareAzureBastionDeploy
              .to(sshBastionAzureDeploy)
              .to(parseAzureResult)
              .to(checkAzureSuccess
                .onTrue(extractAzureTargetIp.to(sshBastionHealthCheck))
                .onFalse(debuggerAgent)
              )
            )
          )
        )
        .onFalse(updateStatusRejected)
      )
    )
    .onFalse(buildChatHistory
      .to(deploymentChatAgent)
      .to(appendAiResponse)
      .to(respondChatReply.to(chatWait))
    )
  )
  .add(sshBastionHealthCheck)
  .to(parseHealthResult)
  .to(checkHealthStatus
    .onTrue(updateStatusSuccess)
    .onFalse(debuggerAgent)
  )
  .add(debuggerAgent)
  .to(updateStatusFailed)

  .add(monitoringSchedule)
  .to(fetchActiveDeployments)
  .to(monitorHealth)
  .to(checkMonitorStatus
    .onTrue(markDeploymentUnhealthy)
  );
