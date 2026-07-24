{{/* Release-scoped name used by every first-party resource. */}}
{{- define "oxscada-full.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels shared by all resources. */}}
{{- define "oxscada-full.labels" -}}
app.kubernetes.io/name: oxscada
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Stable, release-scoped selectors for one component. */}}
{{- define "oxscada-full.selectorLabels" -}}
app.kubernetes.io/name: oxscada
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Compose an image from the global registry and component image values. */}}
{{- define "oxscada-full.image" -}}
{{- $root := index . 0 -}}
{{- $image := index . 1 -}}
{{- $registry := default $root.Values.global.imageRegistry $image.registry -}}
{{- printf "%s/%s:%s" $registry $image.repository $image.tag -}}
{{- end -}}
