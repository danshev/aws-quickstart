# AWS Organization Bootstrap Template

This repository bootstraps an AWS Organization and deploys self-mutating CDK pipelines from a Shared Services account. The intended source control model is GitHub via AWS CodeConnections.

The repository currently supports:

- organization setup from [`scripts/org/org-config.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/org-config.yaml)
- one infrastructure pipeline in the Shared Services account
- one application pipeline per configured app
- explicit CodePipeline V2 triggers with branch filters and optional path include/exclude filters
- optional centralized security resources and optional centralized egress networking

## Current Repo State

- Local developer commands are `npm`-first and come from [`package.json`](/Users/dan/Documents/casco-tech/aws-quickstart/package.json).
- Pipeline synth in both pipeline stacks installs `pnpm` and runs `pnpm install --frozen-lockfile`, `pnpm run build`, and `pnpm -r run build`.
- The repo currently has [`pnpm-workspace.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/pnpm-workspace.yaml) but no checked-in `pnpm-lock.yaml`. Before deploying the pipelines, generate and commit a lockfile or the pipeline synth step will fail.
- The default [`scripts/org/org-config.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/org-config.yaml) ships with `apps: []`.
- [`config/load-config.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/config/load-config.ts) requires at least one app, so `npm run synth` and `cdk synth` will not work until you add an app and regenerate [`config/defaults.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/config/defaults.ts).
- The checked-in sample app is [`lib/testapp`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/testapp). It creates an S3 bucket and can optionally deploy spoke networking when `spokeCidr` is present.

## Source and Trigger Model

Pipelines are sourced from GitHub through AWS CodeConnections, not CodeCommit.

Both [`lib/pipeline/infra-pipeline-stack.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/pipeline/infra-pipeline-stack.ts) and [`lib/pipeline/app-pipeline-stack.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/pipeline/app-pipeline-stack.ts):

- create `CodePipelineSource.connection(...)` sources
- set `pipelineType: codepipeline.PipelineType.V2`
- disable default source push detection with `triggerOnPush: false`
- add an explicit V2 trigger with `repositoryBranch`
- optionally apply `triggerOnPaths.filePathsIncludes`
- optionally apply `triggerOnPaths.filePathsExcludes`

`triggerOnPaths` is validated in [`config/load-config.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/config/load-config.ts):

- maximum 8 include patterns
- maximum 8 exclude patterns

## Quick Start

### 1. Prerequisites

- Node.js `>=20 <23`
- AWS CLI configured for the management account
- `jq` available locally if you plan to use [`scripts/act-as-account.sh`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/act-as-account.sh)

Install dependencies:

```bash
npm install
```

### 2. Customize the Org Config

Edit [`scripts/org/org-config.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/org-config.yaml).

This file is the source of truth for:

- AWS region
- IAM Identity Center bootstrap identity
- OU and account layout
- Shared Services account designation
- pipeline source settings
- optional centralized egress network settings

By default it creates or reuses only these member accounts:

- Shared Services
- Log Archive
- Audit

Workload accounts are intentionally left commented out for the first 24 hours after organization creation.

### 3. Create or Reuse the Organization Accounts

```bash
aws organizations create-organization --feature-set ALL
aws ram enable-sharing-with-aws-organization

npm run org:build
npm run org:move
```

What these scripts do:

- `org:build` creates or reuses OUs and accounts, and records state in `.org-state.json`
- `org:move` waits for account creation to finish, recovers reusable accounts where possible, and moves each account into its target OU

### 4. Create a Non-Root Management Principal

```bash
npm run org:setup-principal
```

This creates a management-account setup role and temporary IAM user so the remaining cross-account scripts can run without using the root user.

After following the printed credential/profile instructions, optional console setup can continue with:

```bash
npm run org:iam
```

### 5. Optional Org-Level Security Setup

```bash
npm run org:scps
npm run org:security
```

Current behavior:

- `org:scps` deploys preventive SCPs from the management account
- `org:security` enables default EBS encryption, S3 Block Public Access, organization-wide IAM Access Analyzer, and registers the Audit account as the CloudTrail delegated administrator

### 6. Bootstrap CDK in All Accounts

```bash
npm run org:bootstrap
```

To skip accounts that were detected as pre-existing during `org:build`:

```bash
npm run org:bootstrap -- --skip-existing-accounts
```

### 7. Add the First App

The repository is not synthesizable until at least one app exists.

Use the helper:

```bash
npm run org:add-app -- --name myapp --repoName my-repo
```

What `org:add-app` currently does:

- appends app pipeline config to [`scripts/org/org-config.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/org-config.yaml)
- adds workload account entries under discovered stages
- scaffolds `lib/<app>/app-stage.ts`
- scaffolds `lib/<app>/stacks/app-resources-stack.ts`
- adds path filters for the new app pipeline and infra pipeline

What it does not do:

- it does not scaffold `packages/<app>/`
- it does not add runtime application code

After adding the app, create and place the workload accounts:

```bash
npm run org:build
npm run org:move
npm run org:bootstrap
npm run org:finalize
```

### 8. Finalize Generated CDK Config

```bash
npm run org:finalize
```

[`scripts/org/finalize.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/finalize.ts) currently:

- resolves live account IDs from AWS Organizations
- writes [`config/defaults.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/config/defaults.ts)
- renames `README.md` to `SETUP.md` if `SETUP.md` does not already exist
- recreates an empty `README.md`

That README rewrite behavior is real current code, even though it is surprising for a template repository.

### 9. Create the GitHub Connection

Create an AWS CodeConnections connection in the Shared Services account and in the same region as the pipeline stack.

Then set the connection ARN in [`scripts/org/org-config.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/org-config.yaml):

- `infraPipeline.connectionArn`
- `apps[].pipeline.connectionArn`

The connection must be in the Shared Services account because that is where the pipeline stacks are deployed.

### 10. Assume the Shared Services Role and Deploy Pipelines

Use the current helper script:

```bash
source ./scripts/act-as-account.sh <shared-services-account-id>
```

Then deploy:

```bash
npm run synth
npm run deploy -- '*Pipeline'
```

After that, pushing to the configured GitHub branch triggers the pipelines through CodeConnections.

## Path Filter Strategy

The repo is designed for monorepo-style path filtering, but the filters are optional.

Recommended app include set:

```yaml
triggerOnPaths:
  filePathsIncludes:
    - "lib/<app>/**"
    - "packages/<app>/**"
    - "lib/constructs/**"
    - "lib/infra/spoke-network-stack.ts"
    - "lib/pipeline/app-pipeline-stack.ts"
    - "lib/app-stage-props.ts"
    - "bin/app.ts"
    - "config/**"
```

Recommended infra excludes:

```yaml
infraPipeline:
  triggerOnPaths:
    filePathsExcludes:
      - "packages/**"
      - "lib/<app>/**"
```

Notes:

- the include pattern `packages/<app>/**` is useful if you later add runtime code there
- the template checkout does not currently include populated app packages
- branch filters always apply even when path filters are omitted

## Optional Features

### Centralized Egress Networking

Networking is controlled from [`scripts/org/org-config.yaml`](/Users/dan/Documents/casco-tech/aws-quickstart/scripts/org/org-config.yaml), not from `config/local.ts`.

The code expects:

```yaml
network:
  egressVpcCidr: "10.0.0.0/16"
  spokeCidrs:
    dev: "10.1.0.0/16"
    prod: "10.2.0.0/16"
  tgwAsn: 64512
```

Then run:

```bash
npm run org:finalize
```

Current implementation:

- Shared Services can deploy a Transit Gateway, egress VPC, RAM share, SSM parameters, and a cross-account SSM reader role
- workload stages with `spokeCidr` deploy a private spoke VPC, TGW attachment, SSM endpoints, and a demo EC2 instance

Relevant files:

- [lib/infra/network-hub-stack.ts](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/network-hub-stack.ts)
- [lib/infra/spoke-network-stack.ts](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/spoke-network-stack.ts)

### Security Baseline

Security account IDs are generated into [`config/defaults.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/config/defaults.ts) by `org:finalize` when Log Archive and Audit accounts exist.

The account layout follows the [AWS Security Reference Architecture (SRA)](https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/security-tooling.html):

- **Log Archive account** — immutable log storage (CloudTrail, Config)
- **Audit account** — delegated administrator for security services (CloudTrail, and eventually GuardDuty, SecurityHub, Config); also hosts budget/cost anomaly alerts
- **Shared Services account** — CI/CD pipelines and shared operational infrastructure only

Optional security overrides such as alert email or allowed regions belong in `config/local.ts`, for example:

```typescript
import type { BootstrapConfig } from "./schema";

export const localConfig: Partial<BootstrapConfig> = {
  security: {
    alertEmail: "security@example.com",
    monthlyBudgetUsd: 1000,
    allowedRegions: ["us-east-1"],
  },
};
```

Current implementation includes:

- log archive S3 buckets deployed to the Log Archive account
- org-wide CloudTrail trail deployed to the Audit account (currently disabled pending management account CDK bootstrap)
- budget alerts and cost anomaly detection deployed to the Audit account
- org scripts for SCP deployment, account-level security defaults, and Audit account delegated admin registration

Relevant files:

- [lib/infra/security-stage.ts](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/security-stage.ts)
- [lib/infra/log-archive-stack.ts](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/log-archive-stack.ts)
- [lib/infra/org-cloudtrail-stack.ts](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/org-cloudtrail-stack.ts)
- [lib/infra/budget-alerts-stack.ts](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/budget-alerts-stack.ts)

### Domain and Media CDN Support

The codebase includes domain-related support, but it is not a built-in end-to-end feature of the checked-in sample app.

Current state:

- [`lib/infra/shared-services-stage.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/infra/shared-services-stage.ts) deploys shared Route 53 resources when an app has `domain` config
- the checked-in sample app in [`lib/testapp`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/testapp) does not use domain config
- the repo includes reusable constructs such as [`lib/constructs/media-cdn.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/constructs/media-cdn.ts) and [`lib/constructs/ses-email-identity.ts`](/Users/dan/Documents/casco-tech/aws-quickstart/lib/constructs/ses-email-identity.ts) for extension work

This README does not treat GraphQL, Stripe, Cognito, SES, or CloudFront constructs as turnkey template features because they are not wired into a complete default application flow in the current repository.

## Commands

Commands from [`package.json`](/Users/dan/Documents/casco-tech/aws-quickstart/package.json):

| Command | Description |
| --- | --- |
| `npm install` | Install dependencies and run Husky setup |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Build and run the Node.js test suite from `dist/test/*.test.js` |
| `npm run check` | Run Biome checks |
| `npm run lint` | Run Biome lint checks |
| `npm run lint:fix` | Apply Biome lint fixes |
| `npm run format` | Apply Biome formatting |
| `npm run format:check` | Check Biome formatting |
| `npm run synth` | Run `cdk synth` |
| `npm run deploy` | Run `cdk deploy` |
| `npm run bootstrap:commands` | Print bootstrap commands from resolved config |
| `npm run org:add-app` | Add a new app to org config and scaffold `lib/<app>/` |
| `npm run org:setup-principal` | Create the management-account setup principal |
| `npm run org:build` | Create or reuse OUs and accounts |
| `npm run org:move` | Move accounts into their target OUs |
| `npm run org:bootstrap` | Bootstrap Shared Services and member accounts for CDK |
| `npm run org:iam` | Create the IAM Identity Center user/group/assignment |
| `npm run org:scps` | Deploy preventive SCPs |
| `npm run org:security` | Enable EBS encryption, S3 BPA, IAM Access Analyzer, and register Audit as CloudTrail delegated admin |
| `npm run org:finalize` | Generate `config/defaults.ts` from live AWS data |

## Project Layout

```text
bin/
  app.ts
config/
  schema.ts
  defaults.ts
  local.example.ts
  load-config.ts
lib/
  app-stage-props.ts
  constructs/
  infra/
  pipeline/
  testapp/
scripts/
  act-as-account.sh
  bootstrap/
  org/
test/
  *.test.ts
pnpm-workspace.yaml
package.json
```

Notes:

- `lib/testapp/` is the only checked-in sample app.
- `packages/` is part of the intended workspace shape, but it is not populated in this checkout.
- pipeline code dynamically loads `lib/<app>/app-stage.ts` for each configured app.
