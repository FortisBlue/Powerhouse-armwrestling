# Powerhouse membership and contribution backend

`Code.js` is the source for the Google Apps Script web app used by `/api/membership`.

Current production deployment: **Version 27**, deployed 30 August 2026. The known-good rollback is **Version 26** using the same deployment ID and web-app URL.

## Deploying an update

1. Open the existing Powerhouse Apps Script project using the Google account that owns it.
2. Replace the project's `Code.gs` contents with `Code.js` from this directory.
3. Confirm `CASH_APPROVER_EMAILS` contains the Google accounts allowed to verify cash.
4. Select `setupCashWorkflow` in the Apps Script function menu and run it once. Approve the requested Sheets, Drive, email, and trigger permissions. This creates the protected `Pending Cash` approval column and its installable edit trigger.
5. Choose **Deploy → Manage deployments**, edit the existing web-app deployment, choose **New version**, and deploy it with the same access settings as the current deployment.
6. Only then deploy the website files. The existing `/api/membership` proxy URL does not change.

## Cash approval

A cash application is saved to the `Pending Cash` sheet and does not appear in `Members` or the public member count. After cash is physically received, an authorised approver ticks **Cash Received** in column D. The trigger then adds the active member, creates the signed waiver PDF, and sends the final member and team emails.

If a step fails, the row changes to `Approval error` and records the problem in `Last Error`. After fixing the cause, run `approveCashApplication(ROW_NUMBER)` manually from the Apps Script editor to retry safely.

## Contributions

Successful payments from `/donate` are written to the `Donations` sheet. Donor and team acknowledgements are sent after payment. These acknowledgements explicitly do not claim that the contribution is tax deductible.
