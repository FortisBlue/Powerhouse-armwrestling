// Run with Playwright available in Node's module path. All signup/payment requests are intercepted.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true, channel:'chrome'});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors = [], submissions = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/membership',route=>{
      submissions.push(route.request().postDataJSON());
      return route.fulfill({json:{success:true,pending:true,payment_id:'MOCK-CARD'}});
    });
    await page.route('**/api/member-count',route=>route.fulfill({json:{count:24}}));
    await page.route('**/square.js',route=>route.fulfill({contentType:'application/javascript',body:'window.Square={payments:()=>({card:async()=>({attach:async()=>{},tokenize:async()=>({status:"OK",token:"MOCK-NONCE"})})})};'}));
    await page.goto(process.env.MEMBERSHIP_TEST_URL || 'http://127.0.0.1:8876/membership.html');
    await page.evaluate(() => {
      memberPad = {isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,'+'A'.repeat(1100)};
      document.getElementById('page-1').classList.remove('active');
      document.getElementById('page-2').classList.add('active');
    });
    const name = page.locator('#tshirt-custom-name');
    assert.equal(await name.isVisible(),true);
    await name.fill('The Hammer');
    await page.locator('#tshirt-size').selectOption('Large');
    await page.getByText('Pay cash at training',{exact:true}).click();
    assert.equal(await page.locator('#cash-notice').isVisible(),true);
    assert.equal(await page.locator('#card-payment-wrap').isVisible(),false);
    const cards = await page.locator('.payment-method-card').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
    assert.ok(cards[0].y+cards[0].height <= cards[1].y,'mobile payment choices do not overlap');
    assert.ok(cards.every(r=>r.x>=0 && r.x+r.width<=390),'payment choices fit screen');
    await name.scrollIntoViewIfNeeded();
    await page.screenshot({path:process.env.TEMP+'/powerhouse-tshirt-mobile.png'});
    await page.locator('#submit-btn').click();
    await page.waitForFunction(()=>document.getElementById('confirm').classList.contains('active'));
    assert.equal(submissions[0].tshirt_custom_name,'The Hammer');
    assert.equal(submissions[0].payment_method,'cash');
    await page.evaluate(()=>{document.getElementById('confirm').classList.remove('active');document.getElementById('page-2').classList.add('active');document.getElementById('submit-btn').disabled=false;});
    await page.locator('label[for="join-renew"]').click();
    assert.equal(await name.isVisible(),false);
    assert.equal(await name.inputValue(),'');
    assert.equal(await page.evaluate(()=>buildMembershipPayload('renewing','').tshirt_custom_name),'');
    await page.locator('#tshirt-addon-check').check();
    assert.equal(await name.isVisible(),true);
    await page.locator('#tshirt-addon-size').selectOption('XL');
    await name.fill('Ace');
    await page.getByText('Pay by card',{exact:true}).click();
    assert.equal(await page.locator('#card-payment-wrap').isVisible(),true);
    assert.equal(await page.locator('#cash-notice').isVisible(),false);
    await page.waitForFunction(()=>squareCard !== null);
    await page.locator('#submit-btn').click();
    await page.waitForFunction(()=>document.getElementById('confirm').classList.contains('active'));
    assert.equal(submissions[1].tshirt_custom_name,'Ace');
    assert.equal(submissions[1].payment_method,'card');
    assert.equal(submissions[1].amount_cents,24200);
    assert.equal(submissions[1].nonce,'MOCK-NONCE');
    assert.deepEqual(errors,[]);
    console.log('PASS: mobile layout, Card/Cash choices, new shirt, optional renewal shirt, no-shirt renewal, and both intercepted submission payloads.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
