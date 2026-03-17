/**
 * Minimal CLI argument parser shared across org scripts.
 *
 * Supports:
 *   --config <path>       Path to org-config.yaml (default: scripts/org/org-config.yaml)
 *   --userName <value>    Override identity.userName
 *   --givenName <value>   Override identity.givenName
 *   --familyName <value>  Override identity.familyName
 *   --groupName <value>   Override identity.groupName
 *   --skip-existing-accounts  Skip previously detected existing accounts (org:bootstrap)
 *   --management-profile <name>  AWS CLI profile for the management setup role
 *   --setup-role-name <name>     IAM role name for the setup principal
 *   --caller-profile <name>      AWS CLI profile to use for the calling identity
 *   --trusted-principal-arn <arn> ARN to trust in the setup role (in addition to account root)
 *   --write-config               Write profile/role names back to org-config.yaml
 *   --cleanup                    Remove the temporary IAM user and its credentials
 *   --help                Show usage
 */

export interface CliArgs {
  config?: string;
  userName?: string;
  givenName?: string;
  familyName?: string;
  groupName?: string;
  skipExistingAccounts?: boolean;
  managementProfile?: string;
  setupRoleName?: string;
  callerProfile?: string;
  trustedPrincipalArn?: string;
  writeConfig?: boolean;
  cleanup?: boolean;
}

export function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case "--config":
        args.config = next;
        i++;
        break;
      case "--userName":
        args.userName = next;
        i++;
        break;
      case "--givenName":
        args.givenName = next;
        i++;
        break;
      case "--familyName":
        args.familyName = next;
        i++;
        break;
      case "--groupName":
        args.groupName = next;
        i++;
        break;
      case "--skip-existing-accounts":
        args.skipExistingAccounts = true;
        break;
      case "--management-profile":
        args.managementProfile = next;
        i++;
        break;
      case "--setup-role-name":
        args.setupRoleName = next;
        i++;
        break;
      case "--caller-profile":
        args.callerProfile = next;
        i++;
        break;
      case "--trusted-principal-arn":
        args.trustedPrincipalArn = next;
        i++;
        break;
      case "--write-config":
        args.writeConfig = true;
        break;
      case "--cleanup":
        args.cleanup = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: ts-node <script> [options]

Options:
  --config <path>                 Path to org-config.yaml
  --userName <value>              Override identity.userName
  --givenName <value>             Override identity.givenName
  --familyName <value>            Override identity.familyName
  --groupName <value>             Override identity.groupName
  --skip-existing-accounts        Skip previously detected existing accounts (org:bootstrap)
  --management-profile <name>     AWS CLI profile for the management setup role
  --setup-role-name <name>        IAM role name for the setup principal
  --caller-profile <name>         AWS CLI profile for the calling identity
  --trusted-principal-arn <arn>   ARN to trust in the setup role
  --write-config                  Write profile/role names to org-config.yaml
  --cleanup                       Remove the temporary IAM user
  --help                          Show this message
`);
        process.exit(0);
        break;
      default:
        if (flag.startsWith("--")) {
          console.warn(`Unknown flag: ${flag}`);
        }
    }
  }

  return args;
}
