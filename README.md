# AWS Organization Bootstrap Template

This is a quick-start repository for launching a project using the Organization pattern (i.e., the root account creates an Organization, which — in turn — has Organization Units [OUs]). Account (or accounts), into which resources are deployed, are then nested under the OUs.

In this project, a **Shared Services** account (nested under an Infrastructure OU) owns the CodePipeline resource, which is configured to deploy upon a push to GitHub via an AWS CodeConnections connection.

Net net, this results in:

1.  Shared resources (e.g., domains) in the **Shared Services** account
2.  Centralized security logging in the **Log Archive** account
3.  Centralized security/audit controls in the **Audit** account

After the first 24 hours from org creation, add workload accounts (e.g. `App 1 (dev)` and `App 1 (prod)`) under `Workloads` and rerun the org scripts.

## Monorepo Model (Expected)

This template is designed for a **monorepo-first** workflow.

- One repository contains org/bootstrap infra, shared CDK code, and one or more app codebases.
- Each app name in `org-config.yaml` maps to code paths in this repo:
  - `lib/<app>/**` for app CDK stacks/stages
  - `packages/<app>/**` for app runtime/business logic
- App pipeline synthesis builds from the monorepo root, not from an app subdirectory.

### Why this matters

- App pipelines dynamically load `lib/<app>/app-stage.ts`.
- Pipeline synth/build commands run from repo root and expect a workspace layout.
- `triggerOnPaths` is most useful in monorepos, where multiple apps share one repo and one branch.

## Setup

### Phase 0: Customize the Org Config

All organization structure, identity, and pipeline settings live in a single YAML file:

```
scripts/org/org-config.yaml
```

Edit it to match your desired org structure. You can rename accounts, add environments (e.g. `staging`, `qa`), change the default region, and set your IAM Identity Center user details — all without touching any scripts.

See [Org Config Reference](#org-config-reference) for the full schema.

### Phase 1: Organizational Setup

1. Login to the desired root AWS account

```bash
aws login
```

2. Create an Organization

```bash
aws organizations create-organization --feature-set ALL
```

3. Enable sharing within Org via Resource Access Mananger (RAM)

```bash
aws ram enable-sharing-with-aws-organization
```

4. Confirm the auto-email (sent to the root AWS's account email)
   - Note: the confirmation page will show you org structure

5. Install dependencies

```bash
npm install
```

Local workflow note:

- You can run local scripts with `npm run ...`.

Pipeline workflow note:

- CI/CD synth uses `pnpm` workspace commands.
- Keep `pnpm-lock.yaml` and `pnpm-workspace.yaml` committed and current.

6. Build out the Org (OUs + Accounts)

```bash
npm run org:build
```

This reads `scripts/org/org-config.yaml`, creates missing OUs (reusing existing matching OUs), detects/reuses existing accounts by expected email/name, and requests creation only for missing accounts. State is persisted to `.org-state.json`.
During initial bootstrap, the default config creates/reuses only 3 member accounts: Shared Services, Log Archive, and Audit.

7. **Wait** for confirmation emails (~3 minutes), then move accounts under their OUs

```bash
npm run org:move
```

This polls AWS until account requests are resolved, recovers account IDs when AWS reports `EMAIL_ALREADY_EXISTS`/name-exists failures, and then moves each account from its current parent to its target OU. You can safely re-run it if accounts are still pending.

8. Create a non-root IAM principal in the management account

```bash
npm run org:setup-principal
```

The management root user cannot call `sts:AssumeRole`, which `org:bootstrap` and `org:security` require for cross-account operations. This script creates:

- **OrgSetupRole** — scoped IAM role with org + cross-account permissions
- **OrgSetupUser** — temporary IAM user that can assume the role

Follow the printed instructions to add credentials to `~/.aws/credentials` and a profile to `~/.aws/config`, then verify with `aws sts get-caller-identity --profile org-setup`.

After SSO is configured (step 9), clean up the temporary user:

```bash
npm run org:setup-principal -- --cleanup
```

9. (Optional) Enable console-based access to accounts
   - Using your browser / AWS Console, enable **IAM Identity Center**
   - Once enabled, execute:

   ```bash
   npm run org:iam
   ```

   - Identity details come from `org-config.yaml`. Override on the fly:

   ```bash
   npm run org:iam -- --userName jdoe --givenName Jane --familyName Doe
   ```

   - Using your browser, visit **IAM Identity Center** > Users > send confirmation email

10. (Optional) Deploy preventive Service Control Policies

```bash
npm run org:scps
```

11. (Optional) Enable security defaults in all accounts

```bash
npm run org:security
```

This enables EBS encryption by default, S3 account-level Block Public Access, and an organization-wide IAM Access Analyzer.

12. Bootstrap CDK in all accounts

```bash
npm run org:bootstrap
```

This assumes the cross-account role into each account and runs `cdk bootstrap` with the appropriate trust relationships.
Shared Services is bootstrapped without trust flags; all other configured accounts (security now, workload later) are bootstrapped with `--trust <shared-services-account-id>`.

If `org:build` detected previously existing accounts and you want to avoid re-bootstrapping them:

```bash
npm run org:bootstrap -- --skip-existing-accounts
```

When this skips accounts that require trust bootstrap, the script prints a warning because those accounts may still need a one-time trust re-bootstrap.

### After 24 Hours: Add Workload Accounts

AWS imposes a practical first-24-hours creation limit for new organizations (4 member accounts in addition to the Management account). The default config reserves that initial window for Shared Services + Security accounts.

After the first 24 hours from org creation:

1. Uncomment/add workload stage accounts under `organization.Workloads` in `scripts/org/org-config.yaml` (for example `App 1 (dev)` and `App 1 (prod)`).
2. Re-run:
   ```bash
   npm run org:build
   npm run org:move
   npm run org:bootstrap
   npm run org:finalize
   ```

### Phase 2: Resource Deployment via CDK

13. Inject Org values into CDK config

```bash
npm run org:finalize
```

This resolves live account IDs from AWS and writes `config/defaults.ts`. If workload accounts are not configured yet, app `deploymentTargets` are generated as empty arrays.

14. Create an **AWS CodeConnections** connection to GitHub

- In the AWS Console (Shared Services account), visit `https://<region>.console.aws.amazon.com/codesuite/settings/connections` (for example: [us-east-1](https://us-east-1.console.aws.amazon.com/codesuite/settings/connections))
- Click **Create connection**, select **GitHub**, and follow the OAuth flow
- Wait until the connection status is **AVAILABLE**
- If the connection shows **Pending** or **Needs update**, reauthorize it from the console before running pipelines
- Copy the connection ARN and paste it into `scripts/org/org-config.yaml` under `connectionArn` (for `infraPipeline` and each app pipeline)
- The connection ARN must be in the same AWS account and region as the pipeline stack (`sharedServicesAccountId` + deploy region)
- Re-run `npm run org:finalize` to regenerate `config/defaults.ts`

15. Deploy the bootstrap CDK

```bash
npm run synth                                     # verify all-good (requires non-empty connectionArn values)
source ./pre-bootstrap-scripts/assume_shared_services_role.sh  # act as Shared Services
npm run deploy -- '*Pipeline'                     # initial deploy
```

Before workload accounts are added, app pipelines can exist with no deploy stages. Infra/security deployment remains valid.

Before the first pipeline execution, verify in the AWS Console:

- The service role in **CodePipeline > Your Pipeline > Settings > Service role** is the pipeline execution role you expect
- That role has both `codeconnections:UseConnection` and `codestar-connections:UseConnection` scoped to the specific `connectionArn` (not `"*"`)
- The service role trust policy allows `codepipeline.amazonaws.com` to assume it
- The connection state in **Developer Tools > Connections** is **AVAILABLE**

16. Push to GitHub to trigger the pipeline

```bash
git push origin main
```

## Centralized Egress (Transit Gateway)

An optional Transit Gateway centralized egress pattern routes all workload internet traffic through a single NAT Gateway in the Shared Services account. This provides a single point of control for egress traffic, simplifies IP allowlisting, and reduces NAT Gateway costs across accounts.

Prerequisite: configure workload accounts and rerun `org:finalize` so deployment targets exist.

### Enabling

Add a `network` block to your `config/local.ts`:

```typescript
network: {
  egressVpcCidr: "10.0.0.0/16",
  spokeCidrs: {
    dev: "10.1.0.0/16",
    prod: "10.2.0.0/16",
  },
  tgwAsn: 64512,  // optional, defaults to 64512
},
```

Each workload stage in `deploymentTargets` must have a matching entry in `spokeCidrs`. CIDRs must not overlap.

### Network Config Reference

| Field           | Type                     | Required | Description                                                       |
| --------------- | ------------------------ | -------- | ----------------------------------------------------------------- |
| `egressVpcCidr` | `string`                 | Yes      | CIDR for the Egress VPC in Shared Services (e.g. `"10.0.0.0/16"`) |
| `spokeCidrs`    | `Record<string, string>` | Yes      | CIDR per workload stage (keys must match deployment target names) |
| `tgwAsn`        | `number`                 | No       | BGP ASN for the Transit Gateway (default: `64512`)                |

### What Gets Deployed

**Shared Services account:**

- Transit Gateway with two route tables (Spoke RT, Egress RT)
- Egress VPC with public subnet (NAT GW + IGW) and TGW attachment subnet
- RAM share of the TGW to workload accounts

**Each workload account:**

- Spoke VPC with a private-only subnet
- TGW VPC attachment (auto-accepted via RAM share)
- VPC endpoints for SSM (ssm, ssmmessages, ec2messages)
- Demo EC2 instance (t3.micro, Amazon Linux 2023, SSM-managed)

### Testing Connectivity

After deployment, verify egress routing works via SSM Session Manager:

```bash
# Get the instance ID from stack outputs, then connect:
aws ssm start-session --target <instance-id>

# Inside the session:
ping -c 3 google.com
sudo yum update -y
```

### Cost

The networking infrastructure adds approximately **$234/month** (single-AZ NAT Gateway + TGW attachments + data processing). To tear down, remove the `network` block from config and redeploy.

## Security Baseline

An optional security baseline deploys preventive guardrails, centralized logging, and cost monitoring across the organization.

### What Gets Deployed

**Service Control Policies (SCPs)** — 5 preventive policies attached to the org root:

- `deny-leave-org` — Prevents member accounts from leaving the organization
- `deny-cloudtrail-tampering` — Blocks CloudTrail stop/delete/update actions
- `deny-root-user` — Denies all actions by the root user in member accounts
- `deny-unused-regions` — Restricts API calls to allowed regions only
- `deny-s3-public-access-change` — Prevents disabling S3 Block Public Access

**CloudTrail** — Organization-wide trail (multi-region, file validation enabled) logging to the Log Archive account.

**Log Archive** — Centralized S3 buckets in the Log Archive account with lifecycle rules (1 year → Glacier, 2.7 years → expire).

**Budget Alerts** — Monthly cost budget with 80%/100% threshold alerts and cost anomaly detection ($50 minimum impact), both via SNS email.

**Security Defaults** (per-account, via org scripts):

- EBS encryption enabled by default
- S3 account-level Block Public Access
- IAM Access Analyzer (organization-wide)

### Enabling

Add a `security` block to your `config/local.ts`:

```typescript
security: {
  logArchiveAccountId: "111111111111",
  auditAccountId: "222222222222",
  alertEmail: "security@example.com",
  monthlyBudgetUsd: 1000,
  allowedRegions: ["us-east-1"],
},
```

Then deploy SCPs and security defaults:

```bash
npm run org:scps       # Deploy preventive SCPs to org root
npm run org:security   # Enable EBS encryption, S3 Block Public Access, Access Analyzer
```

### Security Config Reference

| Field                 | Type       | Required | Description                                                                 |
| --------------------- | ---------- | -------- | --------------------------------------------------------------------------- |
| `logArchiveAccountId` | `string`   | Yes      | AWS account ID for the Log Archive account                                  |
| `auditAccountId`      | `string`   | Yes      | AWS account ID for the Audit account                                        |
| `alertEmail`          | `string`   | No       | Email address for budget and cost anomaly alerts                            |
| `monthlyBudgetUsd`    | `number`   | No       | Monthly cost budget in USD (default: `1000`)                                |
| `allowedRegions`      | `string[]` | No       | Allowed AWS regions for the region-deny SCP (defaults to org-config region) |

### Cost

Free to ~$5/month (CloudTrail S3 storage only).

## GraphQL API

An optional GraphQL API deployed per workload stage, using Apollo Server on Lambda with Cognito authentication.

### What Gets Deployed

- **Lambda function** — Apollo Server with `@as-integrations/aws-lambda`, type-graphql schema (decorator-based), Node.js 20
- **API Gateway** — REST API with a `/graphql` endpoint (GET + POST with CORS)
- **Cognito User Pool** — JWT authentication with configurable self-sign-up and password policy
- **Apollo Sandbox** — Enabled in non-prod stages for interactive schema exploration

### Enabling

Add an `apolloGraphQL` block to your `config/local.ts` (all fields are optional — sensible defaults apply):

```typescript
apolloGraphQL: {
  lambdaMemoryMb: 1024,
  lambdaTimeoutSeconds: 30,
  selfSignUpEnabled: true,
  passwordMinLength: 8,
  provisionedConcurrency: 0,
},
```

### GraphQL API Config Reference

| Field                    | Type      | Required | Description                                                       |
| ------------------------ | --------- | -------- | ----------------------------------------------------------------- |
| `lambdaMemoryMb`         | `number`  | No       | Lambda memory in MB (default: `1024`)                             |
| `lambdaTimeoutSeconds`   | `number`  | No       | Lambda timeout in seconds (default: `30`)                         |
| `selfSignUpEnabled`      | `boolean` | No       | Whether Cognito self-sign-up is enabled (default: `true`)         |
| `passwordMinLength`      | `number`  | No       | Minimum password length for Cognito (default: `8`)                |
| `provisionedConcurrency` | `number`  | No       | Provisioned concurrent Lambda executions (default: `0`, disabled) |

## Configuration-First Workflow

All settings are centralized in typed config files:

### CDK Pipeline Config

- [`config/defaults.ts`](./config/defaults.ts): checked-in placeholders and defaults (generated by `org:finalize`)
- [`config/local.example.ts`](./config/local.example.ts): local override template
- `config/local.ts`: optional local override (gitignored)

### Organization Config

- [`scripts/org/org-config.yaml`](./scripts/org/org-config.yaml): **single source of truth** for the org structure, IAM identity, region, and pipeline settings

## Org Config Reference

```yaml
region: us-east-1 # Default region for all accounts

identity: # IAM Identity Center settings
  userName: jdoe # SSO username
  givenName: Jane # First name
  familyName: Doe # Last name
  groupName: CloudAdmins # SSO group name
  groupDescription: "..." # Group description
  permissionSetName: AdministratorAccess
  sessionDuration: PT8H # ISO 8601 duration

crossAccountRoleName: OrganizationAccountAccessRole # Role for cross-account access
managementProfile: org-setup # AWS CLI profile for the setup role (set by org:setup-principal)
managementSetupRoleName: OrgSetupRole # IAM role name (set by org:setup-principal)

organization: # Declarative OU/account tree
  Infrastructure: # ← OU name
    Shared Services: # ← Account (has account: true)
      account: true
      role: sharedServices # Exactly one account must have this

  # During the first 24 hours after org creation, keep workload accounts
  # commented and bootstrap Shared Services + Security first.
  Workloads:
    # Dev:
    #   App 1 (dev):
    #     account: true
    #     app: myapp                   # Assigns account to the "myapp" app
    #     stage: dev                 # Maps to a CDK deployment target
    #     requiresManualApproval: false
    #
    # Prod:
    #   App 1 (prod):
    #     account: true
    #     app: myapp
    #     stage: prod
    #     requiresManualApproval: true

    # Add more environments easily:
    # Staging:
    #   App 1 (staging):
    #     account: true
    #     stage: staging
    #     requiresManualApproval: false

  Security:
    Log Archive:
      account: true
      role: logArchive
    Audit:
      account: true
      role: audit

infraPipeline: # Infrastructure pipeline (security + shared services)
  name: InfraDeployPipeline
  connectionArn: "arn:aws:..." # CodeConnections ARN (create in AWS Console)
  owner: my-github-user # GitHub owner (user or org)
  repositoryName: my-repo
  repositoryBranch: main
  crossAccountKeys: true
  triggerOnPaths: # Optional V2 path-based trigger
    filePathsExcludes:
      - "packages/**"
      - "lib/myapp/**"

apps: # Per-app pipelines (one CodePipeline each)
  - name: myapp
    pipeline:
      name: MyappPipeline
      connectionArn: "arn:aws:..." # Same connection ARN
      owner: my-github-user
      repositoryName: my-repo
      repositoryBranch: main
      crossAccountKeys: true
      triggerOnPaths:
        filePathsIncludes:
          - "lib/myapp/**"
          - "packages/myapp/**"
          - "lib/constructs/**"
          - "lib/infra/spoke-network-stack.ts"
          - "lib/pipeline/app-pipeline-stack.ts"
          - "lib/app-stage-props.ts"
          - "bin/app.ts"
          - "config/**"
```

### Adding a New Environment

Prerequisite: run this after the first 24-hour AWS account-creation window (or when reusing pre-existing workload accounts).

1. Add the OU + account in `org-config.yaml`:

   ```yaml
   Staging:
     App 1 (staging):
       account: true
       stage: staging
       requiresManualApproval: false
   ```

2. Re-run the setup scripts:
   ```bash
   npm run org:build      # Creates the new OU + account
   npm run org:move       # Moves it into place
   npm run org:bootstrap  # CDK bootstrap with trust
   npm run org:finalize   # Regenerate config/defaults.ts
   ```

No pipeline code changes are required.

### Adding a New App

Prerequisite: run this after the first 24-hour AWS account-creation window (or when reusing pre-existing workload accounts).

Use the `org:add-app` helper to add a second (or third, etc.) app to your organization. It modifies `org-config.yaml` to create account entries under each existing stage OU and adds the app to the `apps[]` array.

```bash
npm run org:add-app -- --name app2 --repoName MyNewRepo
```

| Flag             | Required | Default                       | Description                             |
| ---------------- | -------- | ----------------------------- | --------------------------------------- |
| `--name`         | Yes      | —                             | App identifier (e.g., `app2`)           |
| `--repoName`     | Yes      | —                             | GitHub repository name                  |
| `--displayName`  | No       | Derived from name             | Human name for accounts (e.g., "App 2") |
| `--repoBranch`   | No       | `main`                        | Repository branch                       |
| `--pipelineName` | No       | `<PascalCase>Pipeline`        | Pipeline name                           |
| `--config`       | No       | `scripts/org/org-config.yaml` | Path to config file                     |

After running the command, follow these steps:

1. **Create accounts and bootstrap:**

   ```bash
   npm run org:build       # Create new accounts
   npm run org:move        # Move accounts to target OUs (~3 min)
   npm run org:bootstrap   # CDK bootstrap with trust
   npm run org:finalize    # Regenerate config/defaults.ts
   ```

2. **Deploy the pipeline:**

   ```bash
   npm run synth
   npm run deploy
   ```

3. **Push to GitHub to trigger the pipeline:**
   ```bash
   git push origin main
   ```

> [!NOTE]
> `org:add-app` assumes the monorepo layout described in this README.
>
> - It scaffolds app paths using `lib/<app>/**` and `packages/<app>/**`.
> - It adds `triggerOnPaths.filePathsIncludes` to the new app pipeline.
> - It appends `lib/<app>/**` to `infraPipeline.triggerOnPaths.filePathsExcludes`.
>
> Keep app includes and infra excludes in sync whenever you add apps or move shared code.

## Path-Based Trigger Strategy (Recommended Defaults)

Pipelines always use an explicit CodePipeline V2 trigger linked to the source action.
`triggerOnPaths` only adds file-path filters to that explicit trigger.

- `filePathsIncludes`: pipeline runs only when at least one changed file matches.
- `filePathsExcludes`: pipeline is skipped when changed files match excluded paths.
- Branch filters always apply (`repositoryBranch`) even when `triggerOnPaths` is not set.
- Max 8 include patterns and max 8 exclude patterns per pipeline.

### Recommended app include set

Use this in `scripts/org/org-config.yaml` under `apps[].pipeline` for your app:

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

### Recommended infra excludes pattern

Use infra excludes to avoid running the infra pipeline for app-only changes:

```yaml
infraPipeline:
  triggerOnPaths:
    filePathsExcludes:
      - "packages/**"
      - "lib/<app>/**"
      # Add one line per additional app:
      # - "lib/app2/**"
```

### Change impact quick matrix

| Change location                                | Typical pipeline impact                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `lib/infra/**`                                 | Infra pipeline                                                    |
| `lib/<app>/**`, `packages/<app>/**`            | App pipeline                                                      |
| `lib/constructs/**`, `config/**`, `bin/app.ts` | Often both infra and app pipelines                                |
| `scripts/org/**`                               | Usually no deploy trigger unless pipeline/config behavior changed |

### If you are not using a monorepo

You can still use this template with one repo per app by setting each app's `owner` and `repositoryName` to its own repository.

In that model:

- app pipeline `triggerOnPaths` is optional (often unnecessary),
- infra pipeline path filters can usually be simplified.

## Prerequisites / Other Info

- Node.js `>=20 <23`

### Monorepo Contract (Recommended)

| Area                  | Expected shape                                  | Why                                                       |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| App CDK entrypoint    | `lib/<app>/app-stage.ts`                        | App pipeline dynamically resolves this path at synth time |
| App CDK stacks        | `lib/<app>/stacks/**`                           | Keeps app infrastructure isolated per app                 |
| App runtime code      | `packages/<app>/**`                             | Keeps app business logic isolated per app                 |
| Shared CDK constructs | `lib/constructs/**`                             | Shared infra primitives for all apps                      |
| Workspace config      | `pnpm-workspace.yaml` with `packages/**`        | Pipeline synth/build uses pnpm workspace commands         |
| Resolved config       | `config/defaults.ts` via `npm run org:finalize` | Ensures account IDs and pipeline config are in sync       |

### 1. Install dependencies

```bash
npm install
```

`npm install` runs the `prepare` script and enables local git hooks via Husky.

Pipeline workflow note:

- CI/CD synth uses `pnpm` workspace commands.
- Keep `pnpm-lock.yaml` and `pnpm-workspace.yaml` committed and current.

### Organization values

Edit `scripts/org/org-config.yaml` for the org structure, then run `npm run org:finalize` to sync into `config/defaults.ts`.

For local CDK overrides, create `config/local.ts` from `config/local.example.ts`.

### Bootstrap commands from config

```bash
npm run bootstrap:commands
```

## Project Structure

```text
/bin
  app.ts                          # CDK app entrypoint
/config
  schema.ts                       # Shared config interfaces
  defaults.ts                     # Checked-in defaults/placeholders (generated)
  local.example.ts                # Local override example
  load-config.ts                  # Merge + validation
/lib
  /constructs                       # Shared org-wide CDK constructs
    cognito-pool.ts               # Reusable Cognito User Pool construct
    media-cdn.ts                  # CloudFront + S3 media CDN construct
  /infra                            # Infra-pipeline stacks + stages
    budget-alerts-stack.ts        # AWS Budgets + Cost Anomaly Detection
    log-archive-stack.ts          # Centralized S3 buckets for CloudTrail logs
    network-hub-stack.ts          # TGW + Egress VPC (Shared Services)
    org-cloudtrail-stack.ts       # Organization-wide CloudTrail trail
    shared-resources-stack.ts     # Route 53 + delegation role
    security-stage.ts             # Log Archive, CloudTrail, Budget Alerts
    shared-services-stage.ts      # Shared Services stage
  /<app>                              # Per-app CDK stacks + stage (created by org:add-app)
    app-stage.ts                  # Stage composition
    /stacks
      app-resources-stack.ts      # App-specific resources
  /pipeline
    infra-pipeline-stack.ts       # Infra pipeline (GitHub via CodeConnections)
    app-pipeline-stack.ts         # Per-app pipeline (GitHub via CodeConnections)
/packages
  /<app>                              # Per-app runtime/business logic
/scripts
  /bootstrap
    print-bootstrap-commands.ts   # Emits cdk bootstrap commands from config
  /org
    org-config.yaml               # ★ Single source of truth for org structure
    types.ts                      # Shared types for org scripts
    cli.ts                        # CLI argument parser
    parse-org-config.ts           # YAML reader + tree walker
    add-app.ts                    # Add a new app to org-config.yaml
    aws-helpers.ts                # AWS CLI + STS wrappers
    build-org.ts                  # Create OUs + request accounts
    move-accounts.ts              # Poll + move accounts to target OUs
    bootstrap-cdk.ts              # CDK bootstrap all accounts
    enable-iam-user.ts            # IAM Identity Center setup
    deploy-scps.ts                # Deploy preventive SCPs to org root
    enable-security-defaults.ts   # EBS encryption, S3 BPA, Access Analyzer
    setup-principal.ts            # Create non-root management principal
    finalize.ts                   # Generate config/defaults.ts from live data
/pre-bootstrap-scripts
  assume_shared_services_role.sh  # Source to assume Shared Services role
/test
  bootstrap-commands.test.ts
  config-validation.test.ts
  network-hub-stack.test.ts
  org-config.test.ts
  infra-pipeline-stack.test.ts
  app-pipeline-stack.test.ts
  spoke-network-stack.test.ts
  ses-email-identity.test.ts
  add-app.test.ts
```

## Template Extension

To add a new environment (for example `qa` or `sandbox`), add the OU and account to `scripts/org/org-config.yaml` and re-run the org scripts after the first 24-hour account-creation window. The pipeline automatically picks up new stages via `config/defaults.ts`.

No pipeline code changes are required.

## Scripts

| Command                       | Description                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run org:add-app`         | Add a new app to org-config.yaml (accounts + pipeline; workload stages required)                                                                |
| `npm run org:setup-principal` | Create non-root IAM principal in management account for cross-account operations (`--cleanup` to remove temp user after SSO)                    |
| `npm run org:build`           | Create/reuse OUs, detect/reuse existing accounts, request missing accounts (initial default: Shared Services + Security only)                   |
| `npm run org:move`            | Poll account requests, recover IDs on email/name conflicts, move accounts to target OUs                                                         |
| `npm run org:bootstrap`       | CDK bootstrap Shared Services (no trust) and all other configured member accounts with trust (or skip existing with `--skip-existing-accounts`) |
| `npm run org:iam`             | Set up IAM Identity Center user/group/assignments                                                                                               |
| `npm run org:scps`            | Deploy preventive SCPs to org root                                                                                                              |
| `npm run org:security`        | Enable EBS encryption, S3 Block Public Access, IAM Access Analyzer                                                                              |
| `npm run org:finalize`        | Generate config/defaults.ts from live AWS data (app deploymentTargets may be empty before workload accounts are added)                          |
| `npm run bootstrap:commands`  | Print bootstrap commands from resolved config                                                                                                   |
| `npm run synth`               | Synthesize the CDK app                                                                                                                          |
| `npm run deploy`              | Deploy the pipeline stack                                                                                                                       |
| `npm run check`               | Run Biome lint + format checks                                                                                                                  |
| `npm run lint`                | Run Biome linter checks                                                                                                                         |
| `npm run lint:fix`            | Auto-fix lint issues                                                                                                                            |
| `npm run format:check`        | Run formatter checks                                                                                                                            |
| `npm run format`              | Apply Biome formatting                                                                                                                          |
| `npm test`                    | Run template tests                                                                                                                              |

### CLI Overrides

All `org:*` scripts accept `--config <path>` to use an alternative org-config.yaml.

`org:bootstrap` additionally accepts:

```bash
npm run org:bootstrap -- --skip-existing-accounts
```

Use this after `org:build` when existing accounts were detected/reused and should not be bootstrapped again. If skipped accounts require trust bootstrap, the script warns so you can rerun without skip (or run targeted trust bootstrap commands).

`org:setup-principal` additionally accepts:

```bash
npm run org:setup-principal -- --cleanup
npm run org:setup-principal -- --setup-role-name CustomRole --management-profile custom-profile
npm run org:setup-principal -- --caller-profile my-root-profile
npm run org:setup-principal -- --trusted-principal-arn arn:aws:iam::123456789012:role/SomeRole
```

`org:iam` additionally accepts identity overrides:

```bash
npm run org:iam -- --userName jdoe --givenName Jane --familyName Doe --groupName DevAdmins
```
