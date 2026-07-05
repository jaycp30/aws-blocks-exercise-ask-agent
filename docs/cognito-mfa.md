# Cognito MFA operations

The application uses an Amazon Cognito user pool with these controls:

- accounts are created by an administrator (`selfSignUp: false`)
- email address is the sign-in identifier
- TOTP MFA is required
- passwords require 12 characters, uppercase, lowercase, a number and a symbol
- browser sessions last eight hours
- sign-out revokes the Cognito refresh token
- the user pool and session store are retained if the stack is deleted

## Before deployment

This deployment creates an Amazon Cognito **Essentials** user pool. Cognito can be
billable based on monthly active users and enabled features. Review the current
Cognito pricing before deploying outside the free allowance.

The previous `AuthBasic` users are not migrated. They live in DynamoDB and cannot
authenticate against Cognito. The previous shared invite-code parameter is no longer
read by the application.

Run the preflight locally:

```bash
npm run typecheck
npm run test:e2e
AWS_REGION=ap-northeast-1 npx cdk synth
```

Deploy only after reviewing the synthesized Cognito resources:

```bash
AWS_REGION=ap-northeast-1 npm run deploy
```

## Find the deployed user pool

```bash
POOL_ID=$(aws cloudformation list-stack-resources --stack-name ask-aws-agent-stack-prod --region ap-northeast-1 --query "StackResourceSummaries[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId | [0]" --output text)
echo "$POOL_ID"
```

## Create a user

Replace the email address before running this command. Cognito emails the user a
temporary password. The first login then requires a new password and TOTP enrolment.

```bash
EMAIL="teammate@example.com"
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$EMAIL" --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true --desired-delivery-mediums EMAIL --region ap-northeast-1
```

The user scans the QR code displayed by the application with an authenticator app and
enters the current six-digit code. A text setup key remains available as a fallback for
devices that cannot scan the QR code. Later logins always require a fresh TOTP code.

## Forgotten or administrator-reset password

Use **Forgot password?** on the sign-in screen. Cognito emails a six-digit code to the
user's verified email address; the application accepts that code and the new password
on the next screen. Resetting a password does not remove the user's enrolled TOTP, so
the normal authenticator challenge follows the next successful password sign-in.

If an administrator uses Cognito's reset-password action, Cognito moves the account to
`RESET_REQUIRED` and sends the same type of code. The application detects that state,
opens the reset-code screen automatically, and can send a fresh code if the first one
has expired. Do not use an administrator reset merely to choose a permanent password;
the user-facing flow should complete that operation.

## Disable access

```bash
EMAIL="teammate@example.com"
aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL_ID" --username "$EMAIL" --region ap-northeast-1
aws cognito-idp admin-disable-user --user-pool-id "$POOL_ID" --username "$EMAIL" --region ap-northeast-1
```

## Lost authenticator

Do not attempt to disable the software-token preference with
`admin-set-user-mfa-preference`. Cognito does not permit TOTP to be disabled for an
individual user while the pool requires MFA, and that operation does not reset the
registered TOTP secret.

Treat recovery as an administrator-assisted identity event. First globally sign out
and disable the account. After verifying the user through a separate trusted channel,
either recreate the user or follow a separately reviewed pool-level recovery procedure.
Account recreation is destructive to the Cognito identity and must not be automated.
In this application, conversation ownership currently uses the normalized email address,
so recreating the same verified email retains access to that email's existing application
conversations; take that into account during identity verification.

AWS reference:
https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserMFAPreference.html

## Local development

The E2E suite uses `createLocalTestUser`, which is guarded by
`NODE_ENV !== "production"`. The deployed Lambda explicitly runs with
`NODE_ENV=production`, and the Cognito pool independently disables self-sign-up.
The local AuthCognito mock accepts any six-digit TOTP-shaped value; real Cognito
validates the authenticator code cryptographically.
