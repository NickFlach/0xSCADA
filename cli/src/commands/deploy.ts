import { Command } from "commander";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import ora from "ora";
import {
  output,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputInfo,
  setOutputOptions,
  colors,
  outputTable,
} from "../output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "../../../../");

export interface DeployOptions {
  env: "production" | "staging" | "dev";
  replicas: number;
  namespace: string;
  registry: string;
  dryRun: boolean;
  json?: boolean;
  color?: boolean;
}

function generateDockerCompose(options: DeployOptions): string {
  const envConfig = {
    production: { nodeEnv: "production", replicas: options.replicas || 3, restartPolicy: "always" },
    staging: { nodeEnv: "staging", replicas: options.replicas || 2, restartPolicy: "unless-stopped" },
    dev: { nodeEnv: "development", replicas: options.replicas || 1, restartPolicy: "no" },
  };
  const config = envConfig[options.env];

  return `version: '3.8'
services:
  db:
    image: postgres:15-alpine
    container_name: oxscada-db-${options.env}
    restart: ${config.restartPolicy}
    environment:
      POSTGRES_USER: \${DB_USER:-oxscada}
      POSTGRES_PASSWORD: \${DB_PASSWORD:-oxscada_secret}
      POSTGRES_DB: \${DB_NAME:-oxscada}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER:-oxscada}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - oxscada-network
  app:
    image: ${options.registry}/oxscada-app:latest
    container_name: oxscada-app-${options.env}
    restart: ${config.restartPolicy}
    deploy:
      replicas: ${config.replicas}
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: ${config.nodeEnv}
      DATABASE_URL: postgresql://\${DB_USER:-oxscada}:\${DB_PASSWORD:-oxscada_secret}@db:5432/\${DB_NAME:-oxscada}
      PORT: 5000
    ports:
      - "5000:5000"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:5000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - oxscada-network
${options.env === "dev" ? `  hardhat:
    image: node:20-alpine
    container_name: oxscada-hardhat
    working_dir: /app
    volumes:
      - .:/app
    command: npx hardhat node
    ports:
      - "8545:8545"
    networks:
      - oxscada-network
` : ""}volumes:
  postgres_data:
networks:
  oxscada-network:
    name: oxscada-network-${options.env}
`;
}

function generateK8sDeployment(options: DeployOptions): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: oxscada-app
  namespace: ${options.namespace}
  labels:
    app: oxscada
    environment: ${options.env}
spec:
  replicas: ${options.replicas}
  selector:
    matchLabels:
      app: oxscada
  template:
    metadata:
      labels:
        app: oxscada
        environment: ${options.env}
    spec:
      containers:
      - name: oxscada
        image: ${options.registry}/oxscada-app:latest
        ports:
        - containerPort: 5000
        env:
        - name: NODE_ENV
          value: "${options.env === "dev" ? "development" : options.env}"
        - name: PORT
          value: "5000"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: oxscada-secrets
              key: database-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        readinessProbe:
          httpGet:
            path: /api/health
            port: 5000
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /api/health
            port: 5000
          initialDelaySeconds: 30
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: oxscada-service
  namespace: ${options.namespace}
spec:
  selector:
    app: oxscada
  ports:
    - protocol: TCP
      port: 80
      targetPort: 5000
  type: LoadBalancer
---
apiVersion: v1
kind: Secret
metadata:
  name: oxscada-secrets
  namespace: ${options.namespace}
type: Opaque
stringData:
  database-url: "postgresql://oxscada:oxscada_secret@oxscada-db:5432/oxscada"
`;
}

function generateHelmChart(options: DeployOptions): { [key: string]: string } {
  return {
    "Chart.yaml": `apiVersion: v2
name: oxscada
description: A Helm chart for 0xSCADA
type: application
version: 1.0.0
appVersion: "1.0.0"
`,
    "values.yaml": `replicaCount: ${options.replicas}
image:
  repository: ${options.registry}/oxscada-app
  pullPolicy: IfNotPresent
  tag: "latest"
environment: ${options.env}
service:
  type: LoadBalancer
  port: 80
  targetPort: 5000
`,
    "templates/deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "oxscada.fullname" . }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: oxscada
  template:
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`,
    "templates/service.yaml": `apiVersion: v1
kind: Service
metadata:
  name: {{ include "oxscada.fullname" . }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: {{ .Values.service.targetPort }}
`,
    "templates/_helpers.tpl": `{{- define "oxscada.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "oxscada.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
`,
  };
}

function execCommand(command: string, options: { cwd?: string; dryRun?: boolean } = {}): { success: boolean; output?: string; error?: string } {
  if (options.dryRun) return { success: true, output: `[DRY-RUN] Would execute: ${command}` };
  try {
    const cmdOutput = execSync(command, { cwd: options.cwd || PROJECT_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { success: true, output: cmdOutput.trim() };
  } catch (error: unknown) {
    const execError = error as { stderr?: Buffer | string; message?: string };
    return { success: false, error: execError.stderr?.toString() || execError.message || "Command failed" };
  }
}

export function registerDeployCommand(program: Command): void {
  const deploy = program.command("deploy").description("Deployment and DevOps commands for Docker, Kubernetes, and Helm");

  deploy
    .option("--env <environment>", "Deployment environment (production|staging|dev)", "dev")
    .option("--replicas <number>", "Number of replicas", "1")
    .option("--namespace <namespace>", "Kubernetes namespace", "default")
    .option("--registry <registry>", "Container registry", "docker.io")
    .option("--dry-run", "Preview commands without executing", false)
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output");

  const compose = deploy.command("compose").description("Docker Compose deployment commands");

  compose.command("generate").description("Generate docker-compose.yml").option("--output <path>", "Output file path", "docker-compose.generated.yml")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const options: DeployOptions = { env: parentOpts.env, replicas: parseInt(parentOpts.replicas, 10), namespace: parentOpts.namespace, registry: parentOpts.registry, dryRun: parentOpts.dryRun, json: parentOpts.json };
      const content = generateDockerCompose(options);
      const outputPath = path.resolve(PROJECT_ROOT, cmdOptions.output);
      if (options.dryRun) { if (parentOpts.json) output({ dryRun: true, content, outputPath }); else { outputInfo(`[DRY-RUN] Would write to: ${outputPath}`); console.log(content); } return; }
      try { fs.writeFileSync(outputPath, content); if (parentOpts.json) output({ success: true, outputPath, environment: options.env }); else { outputSuccess(`Generated ${cmdOptions.output} for ${options.env} environment`); outputKeyValue([{ key: "Environment", value: options.env }, { key: "Replicas", value: String(options.replicas) }, { key: "Registry", value: options.registry }, { key: "Output", value: outputPath }]); } } catch (error) { outputError("Failed to generate docker-compose file", error instanceof Error ? error.message : "Unknown error"); }
    });

  compose.command("up").description("Start services using Docker Compose").option("-d, --detach", "Run in detached mode", false).option("-f, --file <path>", "Compose file path", "docker-compose.yml")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const command = `docker compose -f ${cmdOptions.file} up ${cmdOptions.detach ? "-d" : ""}`.trim();
      if (parentOpts.dryRun) { if (parentOpts.json) output({ dryRun: true, command }); else outputInfo(`[DRY-RUN] Would execute: ${command}`); return; }
      if (parentOpts.json) { output(execCommand(command)); return; }
      outputInfo(`Starting services with: ${command}`);
      const proc = spawn("docker", ["compose", "-f", cmdOptions.file, "up", ...(cmdOptions.detach ? ["-d"] : [])], { cwd: PROJECT_ROOT, stdio: "inherit", shell: true });
      proc.on("error", (error) => { outputError("Failed to start Docker Compose", error.message); process.exit(1); });
      proc.on("close", (code) => { if (code === 0) outputSuccess("Services started successfully"); else outputError(`Docker Compose exited with code ${code}`); });
    });

  compose.command("down").description("Stop and remove Docker Compose services").option("-v, --volumes", "Remove volumes", false).option("-f, --file <path>", "Compose file path", "docker-compose.yml")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const command = `docker compose -f ${cmdOptions.file} down ${cmdOptions.volumes ? "-v" : ""}`.trim();
      if (parentOpts.dryRun) { if (parentOpts.json) output({ dryRun: true, command }); else outputInfo(`[DRY-RUN] Would execute: ${command}`); return; }
      const spinner = parentOpts.json ? null : ora("Stopping services...").start();
      const result = execCommand(command);
      if (result.success) { spinner?.succeed("Services stopped successfully"); if (parentOpts.json) output({ success: true, message: "Services stopped", output: result.output }); }
      else { spinner?.fail("Failed to stop services"); outputError("Docker Compose down failed", result.error); }
    });

  compose.command("logs").description("View Docker Compose service logs").option("-f, --follow", "Follow log output", false).option("--tail <lines>", "Number of lines to show", "100").option("-s, --service <name>", "Service name").option("--file <path>", "Compose file path", "docker-compose.yml")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const args = ["compose", "-f", cmdOptions.file, "logs"]; if (cmdOptions.follow) args.push("-f"); args.push("--tail", cmdOptions.tail); if (cmdOptions.service) args.push(cmdOptions.service);
      const command = `docker ${args.join(" ")}`;
      if (parentOpts.dryRun) { if (parentOpts.json) output({ dryRun: true, command }); else outputInfo(`[DRY-RUN] Would execute: ${command}`); return; }
      if (parentOpts.json) { output(execCommand(command)); return; }
      spawn("docker", args, { cwd: PROJECT_ROOT, stdio: "inherit", shell: true }).on("error", (error) => outputError("Failed to get logs", error.message));
    });

  const k8s = deploy.command("k8s").description("Kubernetes deployment commands");

  k8s.command("generate").description("Generate Kubernetes deployment manifests").option("--output <path>", "Output file path", "k8s-deployment.yaml")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const options: DeployOptions = { env: parentOpts.env, replicas: parseInt(parentOpts.replicas, 10), namespace: parentOpts.namespace, registry: parentOpts.registry, dryRun: parentOpts.dryRun, json: parentOpts.json };
      const content = generateK8sDeployment(options);
      const outputPath = path.resolve(PROJECT_ROOT, cmdOptions.output);
      if (options.dryRun) { if (parentOpts.json) output({ dryRun: true, content, outputPath }); else { outputInfo(`[DRY-RUN] Would write to: ${outputPath}`); console.log(content); } return; }
      try { fs.writeFileSync(outputPath, content); if (parentOpts.json) output({ success: true, outputPath, environment: options.env, namespace: options.namespace }); else { outputSuccess(`Generated ${cmdOptions.output} for ${options.env} environment`); outputKeyValue([{ key: "Environment", value: options.env }, { key: "Namespace", value: options.namespace }, { key: "Replicas", value: String(options.replicas) }, { key: "Registry", value: options.registry }, { key: "Output", value: outputPath }]); } } catch (error) { outputError("Failed to generate K8s manifests", error instanceof Error ? error.message : "Unknown error"); }
    });

  k8s.command("apply").description("Apply Kubernetes manifests to cluster").option("-f, --file <path>", "Manifest file path", "k8s-deployment.yaml")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const command = `kubectl apply -f ${cmdOptions.file} --namespace=${parentOpts.namespace}`;
      if (parentOpts.dryRun) { const dryRunCommand = `${command} --dry-run=client`; if (parentOpts.json) output({ dryRun: true, command, result: execCommand(dryRunCommand) }); else { outputInfo(`[DRY-RUN] Would execute: ${command}`); const result = execCommand(dryRunCommand); if (result.output) console.log(result.output); } return; }
      const spinner = parentOpts.json ? null : ora("Applying Kubernetes manifests...").start();
      const result = execCommand(command);
      if (result.success) { spinner?.succeed("Manifests applied successfully"); if (parentOpts.json) output({ success: true, output: result.output }); else if (result.output) console.log(result.output); }
      else { spinner?.fail("Failed to apply manifests"); outputError("kubectl apply failed", result.error); }
    });

  k8s.command("status").description("Show Kubernetes deployment status")
    .action(async (_cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const namespace = parentOpts.namespace;
      if (parentOpts.dryRun) { if (parentOpts.json) output({ dryRun: true, commands: ["kubectl get pods", "kubectl get services", "kubectl get deployments"] }); else outputInfo("[DRY-RUN] Would check Kubernetes cluster status"); return; }
      const statusData: Record<string, unknown> = { namespace };
      const podsResult = execCommand(`kubectl get pods -n ${namespace} -l app=oxscada -o json`);
      if (podsResult.success && podsResult.output) { try { const pods = JSON.parse(podsResult.output); statusData.pods = pods.items?.map((p: Record<string, unknown>) => ({ name: (p.metadata as Record<string, unknown>)?.name, status: (p.status as Record<string, unknown>)?.phase })) || []; } catch { statusData.pods = []; } }
      if (parentOpts.json) { output(statusData); return; }
      console.log(colors.bold("\nPods:")); if ((statusData.pods as Array<Record<string, unknown>>)?.length > 0) outputTable(["Name", "Status"], (statusData.pods as Array<Record<string, unknown>>).map((p) => [String(p.name), String(p.status)])); else console.log(colors.dim("  No pods found"));
    });

  k8s.command("helm").alias("helm-chart").description("Generate Helm chart for 0xSCADA").option("--output <path>", "Output directory", "charts/oxscada")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const options: DeployOptions = { env: parentOpts.env, replicas: parseInt(parentOpts.replicas, 10), namespace: parentOpts.namespace, registry: parentOpts.registry, dryRun: parentOpts.dryRun, json: parentOpts.json };
      const chartFiles = generateHelmChart(options);
      const outputDir = path.resolve(PROJECT_ROOT, cmdOptions.output);
      if (options.dryRun) { if (parentOpts.json) output({ dryRun: true, files: Object.keys(chartFiles), outputDir }); else { outputInfo(`[DRY-RUN] Would create Helm chart at: ${outputDir}`); Object.keys(chartFiles).forEach((file) => console.log(colors.dim(`  - ${file}`))); } return; }
      try { fs.mkdirSync(path.join(outputDir, "templates"), { recursive: true }); for (const [filename, content] of Object.entries(chartFiles)) { const filePath = path.join(outputDir, filename); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, content); } if (parentOpts.json) output({ success: true, outputDir, files: Object.keys(chartFiles) }); else { outputSuccess(`Generated Helm chart at ${cmdOptions.output}`); outputKeyValue([{ key: "Environment", value: options.env }, { key: "Replicas", value: String(options.replicas) }, { key: "Registry", value: options.registry }, { key: "Output", value: outputDir }]); } } catch (error) { outputError("Failed to generate Helm chart", error instanceof Error ? error.message : "Unknown error"); }
    });

  deploy.command("helm").description("Generate Helm chart (alias for deploy k8s helm)").option("--output <path>", "Output directory", "charts/oxscada")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      const options: DeployOptions = { env: parentOpts.env, replicas: parseInt(parentOpts.replicas, 10), namespace: parentOpts.namespace, registry: parentOpts.registry, dryRun: parentOpts.dryRun, json: parentOpts.json };
      const chartFiles = generateHelmChart(options);
      const outputDir = path.resolve(PROJECT_ROOT, cmdOptions.output);
      if (options.dryRun) { if (parentOpts.json) output({ dryRun: true, files: Object.keys(chartFiles), outputDir }); else { outputInfo(`[DRY-RUN] Would create Helm chart at: ${outputDir}`); Object.keys(chartFiles).forEach((file) => console.log(colors.dim(`  - ${file}`))); } return; }
      try { fs.mkdirSync(path.join(outputDir, "templates"), { recursive: true }); for (const [filename, content] of Object.entries(chartFiles)) { const filePath = path.join(outputDir, filename); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, content); } if (parentOpts.json) output({ success: true, outputDir, files: Object.keys(chartFiles) }); else outputSuccess(`Generated Helm chart at ${cmdOptions.output}`); } catch (error) { outputError("Failed to generate Helm chart", error instanceof Error ? error.message : "Unknown error"); }
    });

  deploy.command("healthcheck").description("Check health of deployed services").option("--url <url>", "Health check URL", "http://localhost:5000/api/health")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.opts();
      setOutputOptions({ json: parentOpts.json, color: parentOpts.color });
      if (parentOpts.dryRun) { if (parentOpts.json) output({ dryRun: true, url: cmdOptions.url }); else outputInfo(`[DRY-RUN] Would check health at: ${cmdOptions.url}`); return; }
      const spinner = parentOpts.json ? null : ora("Checking service health...").start();
      try { const response = await fetch(cmdOptions.url); const data = await response.json(); spinner?.stop(); if (parentOpts.json) { output({ success: response.ok, statusCode: response.status, url: cmdOptions.url, data }); return; } if (response.ok) { outputSuccess(`Service is healthy (${response.status})`); outputKeyValue([{ key: "URL", value: cmdOptions.url }, { key: "Status", value: String(response.status) }]); } else outputError(`Health check failed (${response.status})`, JSON.stringify(data)); } catch (error) { spinner?.fail("Health check failed"); outputError("Failed to connect to service", error instanceof Error ? error.message : "Unknown error"); }
    });

  deploy.command("metrics").description("Export deployment metrics").option("--format <format>", "Output format (json|prometheus|csv)", "json")
    .action(async (cmdOptions, cmd) => {
      const parentOpts = cmd.parent.opts();
      setOutputOptions({ json: parentOpts.json || cmdOptions.format === "json", color: parentOpts.color });
      if (parentOpts.dryRun) { if (parentOpts.json) output({ dryRun: true, format: cmdOptions.format }); else outputInfo(`[DRY-RUN] Would export metrics in ${cmdOptions.format} format`); return; }
      const metrics: Record<string, unknown> = { timestamp: new Date().toISOString(), environment: parentOpts.env, namespace: parentOpts.namespace };
      const k8sMetrics = execCommand(`kubectl top pods -n ${parentOpts.namespace} --no-headers 2>/dev/null || echo ""`);
      if (k8sMetrics.success && k8sMetrics.output) { metrics.kubernetes = k8sMetrics.output.split("\n").filter(Boolean).map((line) => { const [name, cpu, memory] = line.trim().split(/\s+/); return { name, cpu, memory }; }); }
      switch (cmdOptions.format) {
        case "prometheus": console.log(`# HELP oxscada_deployment_info Deployment information\n# TYPE oxscada_deployment_info gauge\noxscada_deployment_info{environment="${metrics.environment}",namespace="${metrics.namespace}"} 1`); break;
        case "csv": console.log("timestamp,environment,namespace,pod_name,cpu,memory"); if ((metrics.kubernetes as Array<Record<string, unknown>>)?.length > 0) (metrics.kubernetes as Array<Record<string, unknown>>).forEach((pod) => console.log(`${metrics.timestamp},${metrics.environment},${metrics.namespace},${pod.name},${pod.cpu},${pod.memory}`)); else console.log(`${metrics.timestamp},${metrics.environment},${metrics.namespace},N/A,N/A,N/A`); break;
        default: output(metrics); break;
      }
    });
}
