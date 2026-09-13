# Powerhouse membership and contribution backend

`Code.js` is the source for the Google Apps Script web app used by `/api/membership`.

Current production deployment: **Version 31**, deployed 14 September 2026. The prior deployment is **Version 30** using the same deployment ID and web-app URL. To roll back the shirt-name feature, restore the frontend and saved Apps Script source together with the deployed version (cash approval runs the saved source). Keep the added spreadsheet columns so captured print names are preserved.

## Deploying an update

1. Open the existing Powerhouse Apps Script project using the Google account that owns it.
2. Replace the project's `Code.gs` contents with `Code.js` from this directory.
3. Confirm `CASH_APPROVER_EMAILS` contains the Google accounts allowed to verify cash.
4. For the initial cash-workflow installation only, run `setupCashWorkflow` to create its protected approval column and installable trigger. The production trigger is already installed; do not recreate it for ordinary updates. For the shirt-name update, run `setupTshirtNameColumns` once to append the new headers without changing existing applications.
5. Choose **Deploy → Manage deployments**, edit the existing web-app deployment, choose **New version**, and deploy it with the same access settings as the current deployment.
6. Only then deploy the website files. The existing `/api/membership` proxy URL does not change.

## Cash approval

A cash application is saved to the `Pending Cash` sheet and does not appear in `Members` or the public member count. After cash is physically received, an authorised approver ticks **Cash Received** in column D. The trigger then adds the active member, creates the signed waiver PDF, and sends the final member and team emails.

Cash signature images use `Member Name - DD-MM-YYYY - Signature.png`. Full waiver PDFs for both cash and card use `Member Name - DD-MM-YYYY.pdf`. Dates use Australia/Brisbane and the file creation date. Pending Cash stores the signature file ID, so renaming an image preserves the approval link.

If a step fails, the row changes to `Approval error` and records the problem in `Last Error`. After fixing the cause, run `approveCashApplication(ROW_NUMBER)` manually from the Apps Script editor to retry safely.

## T-shirt print names

The optional `tshirt_custom_name` field appears for new memberships and renewals with a shirt add-on. Blank means the member's surname; renewals without a shirt ignore the field. The server normalises whitespace and rejects custom names over 40 characters before payment or cash storage.

The resolved name to print is saved as **T-Shirt Print Name** in `Sheet1` column **S** and `Pending Cash` column **AA**. Existing columns retain their positions, especially Cash Received (D), Application ID (R in Sheet1), and Last Error (Z in Pending Cash). Older cash rows fall back to their surname when approved. The name follows cash approval into the active sheet and appears in the club/member emails and signed PDF. New cash rows receive their own checkbox; empty rows are not prefilled with FALSE.

Verification: `node --test tests/tshirt-name.test.js` covers card/cash persistence, approval and retry, older rows, surname defaults, no-shirt renewals, pricing, length rejection and literal spreadsheet text. `tests/tshirt-browser.cjs` uses Playwright against a local server (default port 8876), with all membership requests and card tokenisation intercepted, to check the mobile layout and both submission payloads. Set `MEMBERSHIP_TEST_URL` to check the published form with the same intercepted requests.

## Contributions

Successful payments from `/donate` are written to the `Donations` sheet. Donor and team acknowledgements are sent after payment. These acknowledgements explicitly do not claim that the contribution is tax deductible.
