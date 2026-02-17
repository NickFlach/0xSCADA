# GitOps with ArgoCD

## Overview
ArgoCD configuration for automated GitOps deployments of 0xSCADA.

## Files
- `k8s/gitops/argocd-app.yaml` — ArgoCD Application
- `k8s/gitops/argocd-project.yaml` — ArgoCD AppProject

## Setup
```bash
# Install ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Apply 0xSCADA config
kubectl apply -f k8s/gitops/
```

## Sync Policy
- **Auto-sync**: Enabled with self-heal and prune
- **Source**: `main` branch, `helm/oxscada/` path
- **Retry**: Up to 5 attempts with exponential backoff

## Workflow
1. Push changes to `main` branch
2. ArgoCD detects drift
3. Auto-syncs Helm chart to cluster
4. Self-heals any manual changes
