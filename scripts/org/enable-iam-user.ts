#!/usr/bin/env ts-node
/**
 * enable-iam-user.ts — Create an IAM Identity Center user, group, permission
 * set, and assign admin access to all member accounts.
 *
 * Replaces: pre-bootstrap-scripts/enable_iam_user.sh
 *
 * Identity details come from org-config.yaml and can be overridden via CLI:
 *
 *   npx ts-node scripts/org/enable-iam-user.ts \
 *     --userName jdoe \
 *     --givenName Jane \
 *     --familyName Doe
 *
 * Usage:
 *   npx ts-node scripts/org/enable-iam-user.ts [--config path] [--userName x] [--givenName x] [--familyName x] [--groupName x]
 */

import { parseOrgConfig } from "./parse-org-config";
import {
  aws,
  awsJson,
  log,
  logError,
  logStep,
  logSuccess,
  sleep,
} from "./aws-helpers";
import { parseCliArgs } from "./cli";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs();
  const config = parseOrgConfig(args.config);

  // Merge CLI overrides into identity config.
  const identity = {
    ...config.identity,
    ...(args.userName && { userName: args.userName }),
    ...(args.givenName && { givenName: args.givenName }),
    ...(args.familyName && { familyName: args.familyName }),
    ...(args.groupName && { groupName: args.groupName }),
  };

  log(
    "👤",
    `Setting up IAM Identity Center for ${identity.givenName} ${identity.familyName} (${identity.userName})`,
  );

  // -- Discover SSO instance --

  const ssoInstanceArn = aws(
    "sso-admin list-instances --query 'Instances[0].InstanceArn' --output text",
  );
  const identityStoreId = aws(
    "sso-admin list-instances --query 'Instances[0].IdentityStoreId' --output text",
  );
  logSuccess(`SSO instance: ${ssoInstanceArn}`);

  // -- Create group --

  logStep(`Creating group "${identity.groupName}"…`);
  const groupId = aws(
    `identitystore create-group` +
      ` --identity-store-id ${identityStoreId}` +
      ` --display-name "${identity.groupName}"` +
      ` --description "${identity.groupDescription}"` +
      ` --query 'GroupId' --output text`,
  );
  logSuccess(`Group: ${groupId}`);

  // -- Create user --

  const mgmtEmail = aws(
    "organizations describe-organization --query 'Organization.MasterAccountEmail' --output text",
  );

  logStep(`Creating user "${identity.userName}"…`);
  const nameJson = JSON.stringify({
    GivenName: identity.givenName,
    FamilyName: identity.familyName,
  });
  const emailsJson = JSON.stringify([
    { Value: mgmtEmail, Type: "work", Primary: true },
  ]);

  const userId = aws(
    `identitystore create-user` +
      ` --identity-store-id ${identityStoreId}` +
      ` --user-name "${identity.userName}"` +
      ` --display-name "${identity.givenName} ${identity.familyName}"` +
      ` --name '${nameJson}'` +
      ` --emails '${emailsJson}'` +
      ` --query 'UserId' --output text`,
  );
  logSuccess(`User: ${userId}`);

  // -- Add user to group --

  logStep("Adding user to group…");
  aws(
    `identitystore create-group-membership` +
      ` --identity-store-id ${identityStoreId}` +
      ` --group-id ${groupId}` +
      ` --member-id "UserId=${userId}"`,
  );
  logSuccess("Group membership created.");

  // -- Create permission set --

  logStep(`Creating permission set "${identity.permissionSetName}"…`);
  const permSetArn = aws(
    `sso-admin create-permission-set` +
      ` --instance-arn "${ssoInstanceArn}"` +
      ` --name "${identity.permissionSetName}"` +
      ` --description "Full Admin Access"` +
      ` --session-duration "${identity.sessionDuration}"` +
      ` --query 'PermissionSet.PermissionSetArn' --output text`,
  );
  logSuccess(`Permission set: ${permSetArn}`);

  logStep("Attaching AdministratorAccess managed policy…");
  aws(
    `sso-admin attach-managed-policy-to-permission-set` +
      ` --instance-arn "${ssoInstanceArn}"` +
      ` --permission-set-arn "${permSetArn}"` +
      ` --managed-policy-arn "arn:aws:iam::aws:policy/AdministratorAccess"`,
  );
  logSuccess("Policy attached.");

  // -- Assign to all member accounts --

  const mgmtId = aws(
    "organizations describe-organization --query 'Organization.MasterAccountId' --output text",
  );

  const allAccounts = awsJson<{
    Accounts: Array<{ Id: string; Name: string }>;
  }>("organizations list-accounts");

  const targetAccounts = allAccounts.Accounts.filter((a) => a.Id !== mgmtId);

  log(
    "🔗",
    `Assigning admin access to ${targetAccounts.length} member account(s)…`,
  );

  for (const acct of targetAccounts) {
    logStep(`${acct.Name} (${acct.Id})…`);
    aws(
      `sso-admin create-account-assignment` +
        ` --instance-arn "${ssoInstanceArn}"` +
        ` --target-id "${acct.Id}"` +
        ` --target-type "AWS_ACCOUNT"` +
        ` --permission-set-arn "${permSetArn}"` +
        ` --principal-type "GROUP"` +
        ` --principal-id "${groupId}"`,
    );
    await sleep(200); // Small delay to avoid throttling.
  }

  logSuccess("All assignments submitted.");
  log(
    "📧",
    "Don't forget to send the confirmation email from IAM Identity Center > Users.",
  );
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
