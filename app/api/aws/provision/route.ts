import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeNetworkInterfacesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  CreateClusterCommand,
  CreateServiceCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import { CreateServiceLinkedRoleCommand, IAMClient } from "@aws-sdk/client-iam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProvisionPayload = {
  action?: "create" | "status";
  deploymentId?: number;
  projectName?: string;
  image?: string;
  port?: number | string;
  memoryMB?: number;
  cpuLimit?: number;
  healthCheckPath?: string;
  region?: string;
  envVars?: Record<string, string | number | boolean>;
  clusterName?: string;
  serviceName?: string;
};

type AwsConfig = {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  region: string;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function awsError(action: string, err: unknown, details: Record<string, unknown> = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const accessDenied =
    message.includes("AccessDenied") ||
    message.includes("not authorized") ||
    message.includes("no identity-based policy");

  return json(accessDenied ? 403 : 502, {
    ok: false,
    action,
    error: message,
    blocker: accessDenied
      ? "AWS IAM permissions are missing for this provisioner."
      : "AWS provisioning failed before the ECS service became healthy.",
    fix: accessDenied
      ? "Attach the ECS/EC2 policy from docs/credentials.md to the IAM principal used by ACCESS_KEY, then retry."
      : "Check the returned AWS error, ECS service events, subnet/security-group config, and container port.",
    ...details,
  });
}

function getAwsConfig(regionOverride?: string) {
  const accessKeyId = process.env.ACCESS_KEY ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SECRET_KEY ?? process.env.AWS_SECRET_ACCESS_KEY;
  const region =
    regionOverride ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    "us-east-1";

  if (!accessKeyId || !secretAccessKey) {
    return {
      error:
        "Missing AWS credentials. Set ACCESS_KEY and SECRET_KEY in the server environment.",
      region,
    };
  }

  return {
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
    region,
  };
}

function makeClients(aws: AwsConfig) {
  return {
    ecs: new ECSClient({ region: aws.region, credentials: aws.credentials }),
    ec2: new EC2Client({ region: aws.region, credentials: aws.credentials }),
    iam: new IAMClient({ region: aws.region, credentials: aws.credentials }),
  };
}

function authError(request: Request) {
  const expected = process.env.N8N_INTERNAL_API_KEY;
  if (!expected) return null;

  const actual = request.headers.get("x-forge-internal-token");
  if (actual === expected) return null;

  return json(401, {
    ok: false,
    error: "Unauthorized AWS provisioner call.",
  });
}

function serviceNameFor(name: string | undefined, deploymentId?: number) {
  const base = (name || `forge-${deploymentId || "demo"}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const fallback = base.length >= 4 ? base : `forge-${base}`;
  const suffix = deploymentId ? `-${deploymentId}` : "";

  return `${fallback}${suffix}`.slice(0, 48).replace(/-$/g, "");
}

function mapCpu(cpuLimit?: number) {
  if (!cpuLimit || cpuLimit <= 0.25) return "256";
  if (cpuLimit <= 0.5) return "512";
  if (cpuLimit <= 1) return "1024";
  return "2048";
}

function mapMemory(cpu: string, memoryMB?: number) {
  const requested = memoryMB || 512;
  if (cpu === "256") return String(Math.min(Math.max(requested, 512), 2048));
  if (cpu === "512") return String(Math.min(Math.max(requested, 1024), 4096));
  if (cpu === "1024") return String(Math.min(Math.max(requested, 2048), 8192));
  return String(Math.min(Math.max(requested, 4096), 16384));
}

function toEcsEnv(envVars: ProvisionPayload["envVars"]) {
  if (!envVars) return [];
  return Object.entries(envVars).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

async function readPayload(request: Request): Promise<ProvisionPayload | null> {
  try {
    return (await request.json()) as ProvisionPayload;
  } catch {
    return null;
  }
}

async function getNetworking(
  ec2: EC2Client,
  serviceName: string,
  port: number,
) {
  const configuredSubnets = process.env.AWS_SUBNET_IDS?.split(",")
    .map((subnet) => subnet.trim())
    .filter(Boolean);
  const configuredSecurityGroup = process.env.AWS_SECURITY_GROUP_ID;

  if (configuredSubnets?.length && configuredSecurityGroup) {
    return {
      subnets: configuredSubnets,
      securityGroups: [configuredSecurityGroup],
    };
  }

  const vpcs = await ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    }),
  );
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    throw new Error(
      "No default VPC found. Set AWS_SUBNET_IDS and AWS_SECURITY_GROUP_ID for ECS networking.",
    );
  }

  const subnets =
    configuredSubnets ??
    (
      await ec2.send(
        new DescribeSubnetsCommand({
          Filters: [
            { Name: "vpc-id", Values: [vpcId] },
            { Name: "state", Values: ["available"] },
          ],
        }),
      )
    ).Subnets?.map((subnet) => subnet.SubnetId)
      .filter((subnet): subnet is string => Boolean(subnet))
      .slice(0, 3);

  if (!subnets?.length) {
    throw new Error(
      "No usable subnets found. Set AWS_SUBNET_IDS to public subnets for ECS Fargate.",
    );
  }

  if (configuredSecurityGroup) {
    return { subnets, securityGroups: [configuredSecurityGroup] };
  }

  const groupName = `${serviceName}-sg`.slice(0, 64);
  const existingGroups = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [groupName] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }),
  );
  let securityGroupId = existingGroups.SecurityGroups?.[0]?.GroupId;

  if (!securityGroupId) {
    const created = await ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: groupName,
        Description: `Forge ECS demo ingress for ${serviceName}`,
        VpcId: vpcId,
      }),
    );
    securityGroupId = created.GroupId;
  }

  if (!securityGroupId) throw new Error("Failed to create ECS security group.");

  try {
    await ec2.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: port,
            ToPort: port,
            IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Forge ECS demo" }],
          },
        ],
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("InvalidPermission.Duplicate")) throw err;
  }

  return { subnets, securityGroups: [securityGroupId] };
}

async function getTaskPublicUrl(
  ecs: ECSClient,
  ec2: EC2Client,
  clusterName: string,
  serviceName: string,
  port: number,
) {
  const listed = await ecs.send(
    new ListTasksCommand({ cluster: clusterName, serviceName }),
  );
  const taskArns = listed.taskArns ?? [];
  if (!taskArns.length) {
    return { serviceUrl: "", taskStatus: "PENDING", taskArn: "" };
  }

  const described = await ecs.send(
    new DescribeTasksCommand({ cluster: clusterName, tasks: taskArns }),
  );
  const task = described.tasks?.[0];
  const eniId = task?.attachments
    ?.flatMap((attachment) => attachment.details ?? [])
    .find((detail) => detail.name === "networkInterfaceId")?.value;

  if (!eniId) {
    return {
      serviceUrl: "",
      taskStatus: task?.lastStatus ?? "PENDING",
      taskArn: task?.taskArn ?? "",
    };
  }

  const interfaces = await ec2.send(
    new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
  );
  const publicIp = interfaces.NetworkInterfaces?.[0]?.Association?.PublicIp;

  return {
    serviceUrl: publicIp ? `http://${publicIp}:${port}` : "",
    taskStatus: task?.lastStatus ?? "UNKNOWN",
    taskArn: task?.taskArn ?? "",
  };
}

async function ensureEcsServiceLinkedRole(iam: IAMClient) {
  try {
    await iam.send(
      new CreateServiceLinkedRoleCommand({
        AWSServiceName: "ecs.amazonaws.com",
        Description: "Allows Amazon ECS to manage resources for Forge ECS POC services.",
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("InvalidInput") || message.includes("already exists")) return;
    throw err;
  }
}

async function createService(payload: ProvisionPayload) {
  const image = payload.image?.trim();
  if (!image) {
    return json(400, { ok: false, error: "Missing Docker image identifier." });
  }
  if (image.includes("://")) {
    return json(400, {
      ok: false,
      error: "Docker image must be an image reference, not a URL.",
    });
  }

  const aws = getAwsConfig(payload.region);
  if ("error" in aws) {
    return json(500, { ok: false, error: aws.error, region: aws.region });
  }

  const { ecs, ec2, iam } = makeClients(aws);
  const clusterName = process.env.AWS_ECS_CLUSTER_NAME || "forge-poc";
  const serviceName = serviceNameFor(payload.projectName, payload.deploymentId);
  const port = Number(payload.port || 80);
  const cpu = mapCpu(payload.cpuLimit);
  const memory = mapMemory(cpu, payload.memoryMB);

  try {
    await ecs.send(new CreateClusterCommand({ clusterName }));
    await ensureEcsServiceLinkedRole(iam);
    const networking = await getNetworking(ec2, serviceName, port);

    const taskDefinition = await ecs.send(
      new RegisterTaskDefinitionCommand({
        family: serviceName,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu,
        memory,
        executionRoleArn: process.env.AWS_ECS_TASK_EXECUTION_ROLE_ARN,
        containerDefinitions: [
          {
            name: "app",
            image,
            essential: true,
            portMappings: [{ containerPort: port, hostPort: port, protocol: "tcp" }],
            environment: toEcsEnv(payload.envVars),
          },
        ],
      }),
    );

    const service = await ecs.send(
      new CreateServiceCommand({
        cluster: clusterName,
        serviceName,
        taskDefinition: taskDefinition.taskDefinition?.taskDefinitionArn,
        desiredCount: 1,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: networking.subnets,
            securityGroups: networking.securityGroups,
            assignPublicIp: "ENABLED",
          },
        },
      }),
    );

    return json(200, {
      ok: true,
      action: "create",
      status: service.service?.status ?? "ACTIVE",
      clusterName,
      serviceName,
      serviceArn: service.service?.serviceArn,
      taskDefinitionArn: taskDefinition.taskDefinition?.taskDefinitionArn,
      region: aws.region,
      healthCheckPath: payload.healthCheckPath || "/",
      port,
    });
  } catch (err) {
    return awsError("create", err, {
      region: aws.region,
      clusterName,
      serviceName,
    });
  }
}

async function describeService(payload: ProvisionPayload) {
  if (!payload.clusterName || !payload.serviceName) {
    return json(400, {
      ok: false,
      error: "Missing clusterName or serviceName for ECS status check.",
    });
  }

  const aws = getAwsConfig(payload.region);
  if ("error" in aws) {
    return json(500, { ok: false, error: aws.error, region: aws.region });
  }

  const { ecs, ec2 } = makeClients(aws);
  const port = Number(payload.port || 80);

  try {
    const response = await ecs.send(
      new DescribeServicesCommand({
        cluster: payload.clusterName,
        services: [payload.serviceName],
      }),
    );
    const service = response.services?.[0];
    const task = await getTaskPublicUrl(
      ecs,
      ec2,
      payload.clusterName,
      payload.serviceName,
      port,
    );

    return json(200, {
      ok: true,
      action: "status",
      ready: service?.runningCount === 1 && task.taskStatus === "RUNNING",
      status: service?.status,
      runningCount: service?.runningCount ?? 0,
      pendingCount: service?.pendingCount ?? 0,
      taskStatus: task.taskStatus,
      serviceArn: service?.serviceArn,
      serviceName: service?.serviceName,
      clusterName: payload.clusterName,
      serviceUrl: task.serviceUrl,
      taskArn: task.taskArn,
      region: aws.region,
      healthCheckPath: payload.healthCheckPath || "/",
      port,
    });
  } catch (err) {
    return awsError("status", err, {
      region: aws.region,
    });
  }
}

export async function POST(request: Request) {
  const blocked = authError(request);
  if (blocked) return blocked;

  const payload = await readPayload(request);
  if (!payload) return json(400, { ok: false, error: "Request body must be JSON." });

  if (payload.action === "status") return describeService(payload);
  return createService(payload);
}
