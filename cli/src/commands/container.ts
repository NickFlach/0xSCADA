import { Command } from 'commander';
import { execSync, spawn } from 'child_process';

const REGISTRY = 'ghcr.io/nickflach';
const IMAGES = ['oxscada-server', 'oxscada-client', 'oxscada-gateway', 'oxscada-validator', 'oxscada-modbus-driver', 'oxscada-opcua-driver'];

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: opts?.silent ? 'pipe' : 'inherit' });
  } catch (e: any) {
    if (!opts?.silent) console.error(`Command failed: ${cmd}`);
    throw e;
  }
}

export const containerCommand = new Command('container')
  .description('Container management commands for 0xSCADA');

containerCommand
  .command('build')
  .description('Build container images')
  .option('-i, --image <name>', 'Specific image to build (default: all)')
  .option('-t, --tag <tag>', 'Image tag', 'latest')
  .option('--no-cache', 'Build without cache')
  .action((opts) => {
    const images = opts.image ? [opts.image] : IMAGES;
    const cacheFlag = opts.cache === false ? '--no-cache' : '';

    for (const image of images) {
      const dockerfilePath = getDockerfilePath(image);
      console.log(`\n🔨 Building ${image}:${opts.tag}...`);
      run(`docker build ${cacheFlag} -t ${REGISTRY}/${image}:${opts.tag} -f ${dockerfilePath} .`);
      console.log(`✅ ${image}:${opts.tag} built successfully`);
    }
  });

containerCommand
  .command('push')
  .description('Push container images to registry')
  .option('-i, --image <name>', 'Specific image to push (default: all)')
  .option('-t, --tag <tag>', 'Image tag', 'latest')
  .action((opts) => {
    const images = opts.image ? [opts.image] : IMAGES;

    for (const image of images) {
      console.log(`\n📤 Pushing ${REGISTRY}/${image}:${opts.tag}...`);
      run(`docker push ${REGISTRY}/${image}:${opts.tag}`);
      console.log(`✅ ${image}:${opts.tag} pushed successfully`);
    }
  });

containerCommand
  .command('deploy')
  .description('Deploy to Kubernetes cluster')
  .option('-n, --namespace <ns>', 'Kubernetes namespace', 'oxscada')
  .option('--helm', 'Use Helm for deployment')
  .option('-f, --values <file>', 'Helm values file')
  .action((opts) => {
    if (opts.helm) {
      const valuesFlag = opts.values ? `-f ${opts.values}` : '';
      console.log('🚀 Deploying with Helm...');
      run(`helm upgrade --install oxscada ./helm/oxscada -n ${opts.namespace} --create-namespace ${valuesFlag}`);
    } else {
      console.log('🚀 Deploying with kubectl...');
      run(`kubectl apply -f k8s/bootstrap/namespaces.yaml`);
      run(`kubectl apply -f k8s/bootstrap/resource-quotas.yaml`);
      run(`kubectl apply -f k8s/bootstrap/rbac.yaml`);
      run(`kubectl apply -f k8s/database/ -n ${opts.namespace}`);
      run(`kubectl apply -f k8s/app/ -n ${opts.namespace}`);
      run(`kubectl apply -f k8s/ingress/ -n ${opts.namespace}`);
      run(`kubectl apply -f k8s/network/ -n ${opts.namespace}`);
    }
    console.log('✅ Deployment complete');
  });

containerCommand
  .command('status')
  .description('Show container/pod status')
  .option('-n, --namespace <ns>', 'Kubernetes namespace', 'oxscada')
  .option('-a, --all-namespaces', 'Show all 0xSCADA namespaces')
  .action((opts) => {
    if (opts.allNamespaces) {
      for (const ns of ['oxscada', 'oxscada-protocols', 'oxscada-blockchain', 'oxscada-observability']) {
        console.log(`\n📦 Namespace: ${ns}`);
        try { run(`kubectl get pods -n ${ns} -o wide`); } catch { console.log('  (no resources)'); }
      }
    } else {
      run(`kubectl get pods,svc,deploy -n ${opts.namespace} -o wide`);
    }
  });

containerCommand
  .command('logs')
  .description('View container logs')
  .argument('<pod>', 'Pod name or deployment name')
  .option('-n, --namespace <ns>', 'Kubernetes namespace', 'oxscada')
  .option('-f, --follow', 'Follow log output')
  .option('-t, --tail <lines>', 'Number of lines to show', '100')
  .action((pod, opts) => {
    const followFlag = opts.follow ? '-f' : '';
    const target = pod.startsWith('deploy/') ? pod : `deploy/${pod}`;
    const child = spawn('kubectl', ['logs', target, '-n', opts.namespace, `--tail=${opts.tail}`, followFlag].filter(Boolean), {
      stdio: 'inherit',
    });
    child.on('error', (err) => console.error('Failed to get logs:', err.message));
  });

function getDockerfilePath(image: string): string {
  const map: Record<string, string> = {
    'oxscada-server': 'docker/server/Dockerfile',
    'oxscada-client': 'docker/client/Dockerfile',
    'oxscada-gateway': 'docker/gateway/Dockerfile',
    'oxscada-validator': 'docker/validator/Dockerfile',
    'oxscada-modbus-driver': 'services/modbus-driver/Dockerfile',
    'oxscada-opcua-driver': 'services/opcua-driver/Dockerfile',
  };
  return map[image] || `docker/${image.replace('oxscada-', '')}/Dockerfile`;
}

export default containerCommand;
