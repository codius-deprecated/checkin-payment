var express = require('express');
var bodyParser = require('body-parser');
// var auth = require('./lib/auth');
var _ = require('underscore');
var Remote = require('ripple-lib').Remote;
var Amount = require('ripple-lib').Amount;
var twilio = require('twilio');

if (!process.env.ADDRESS) {
  throw new Error('Must supply environment variables ADDRESS');
} else if (!process.env.SECRET) {
  throw new Error('Must supply environment variables SECRET');
} else if (!process.env.USD_ISSUER) {
  throw new Error('Must supply environment variables USD_ISSUER');
} else if (!process.env.TWILIO_ACCOUNT_SID) {
  throw new Error('Must supply environment variables TWILIO_ACCOUNT_SID');
} else if (!process.env.TWILIO_AUTH_TOKEN) {
  throw new Error('Must supply environment variables TWILIO_AUTH_TOKEN');
} else if (!process.env.CHARITY_ADDRESS_0) {
  throw new Error('Must supply environment variables CHARITY_ADDRESS_0');
} else if (!process.env.CHARITY_ADDRESS_1) {
  throw new Error('Must supply environment variables CHARITY_ADDRESS_1');
} else if (!process.env.CHARITY_ADDRESS_2) {
  throw new Error('Must supply environment variables CHARITY_ADDRESS_2');
}

var remote = new Remote({
  trusted:        true,
  local_signing:  true,
  local_fee:      true,
  fee_cushion:     1.5,
  servers: [
    {
        host:    's1.ripple.com'
      , port:    443
      , secure:  true
    }
  ]
});

var app = express();
app.set('port', process.env.PORT || 8000);
app.use(bodyParser.urlencoded());

var twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

var serverStartTime = Date.now();
var usd_to_donate = 5;
var guests = [];
var usd_donated = 0;
var charity_usd_balances = [0,0,0];

// Send 1000 XRP worth of bitcoin to recipient.
function convertToUSD(usd_to_buy, xrp_drops_to_spend) {
  if (typeof usd_to_buy !== 'string') {
    usd_to_buy = usd_to_buy.toString();
  }
  if (typeof xrp_drops_to_spend !== 'string') {
    xrp_drops_to_spend = xrp_drops_to_spend.toString();
  }

  var tx = remote.transaction();
  tx.offerCreate(process.env.ADDRESS, {
    'currency':'USD',
    'issuer':USD_ISSUER,
    'value':usd_to_buy
  }, xrp_drops_to_spend);

  tx.submit(function(err, result) {
    if (err) {
      console.log(err);
      console.log(tx)
    } else {
      console.log(result);
      // console.log('Successfully designated ' + usd_to_spend + ' USD (' + result.metadata.DeliveredAmount.value + ' BTC) to ' + recipient);
    }
  });
}

// Send specified amount of USD to recipient.
function sendUSD(recipient, usd_to_send) {
  if (typeof usd_to_send !== 'string') {
    usd_to_send = usd_to_send.toString();
  }
  var amount = new Amount.from_json({
    'value': usd_to_send,
    'currency': 'USD',
    'issuer': process.env.USD_ISSUER
  });

  var tx = remote.transaction();

  tx.payment(process.env.ADDRESS, recipient, amount);

  tx.submit(function(err, result) {
    if (err) {
      console.log(err);
      console.log(tx)
    } else {
      console.log('Successfully sent ' + usd_to_send + ' USD to ' + recipient);
    }
  });
}

app.get('/name', function(req, res) {
  res.send(guests.shift());
});

app.get('/total', function(req, res) {
  //Could this look at the ripple account's USD balance?
  res.send(usd_donated);
});

app.get('/charity0', function(req, res) {
  res.send(charity_usd_balances[0]);
});

app.get('/charity1', function(req, res) {
  res.send(charity_usd_balances[1]);
});

app.get('/charity2', function(req, res) {
  res.send(charity_usd_balances[2]);
});

// Envoy webhook POST request for each new visitor sign in.
// https://signwithenvoy.com/account/edit/webhook
app.post('/signin', function(req, res) {
  var signin = req.body;

  console.log(signin.entry.your_full_name + ' signed in');

  //TODO: Confirm signature is from Envoy using signin.token && signin.timestamp

  if (signin.status==='sign_in') {
    usd_donated += usd_to_donate;
    guests.push(signin.entry.your_full_name);
  }

  // sendPayment();
  convertToUSD(usd_to_donate, 100);

  res.set('Content-Type', 'text/xml');
  res.sendStatus(200);
});

// Receive SMS notifications from Twilio
// https://www.twilio.com/user/account/phone-numbers/incoming
//1 830-549-6093
app.post('/sms0', function(req, res) {
  charity_usd_balances[0] += usd_to_donate;
  handleSms(req.body, process.env.CHARITY_ADDRESS_0, res);
});

app.post('/sms1', function(req, res) {
  charity_usd_balances[1] += usd_to_donate;
  handleSms(req.body, process.env.CHARITY_ADDRESS_1, res);
});

app.post('/sms2', function(req, res) {
  charity_usd_balances[2] += usd_to_donate;
  handleSms(req.body, process.env.CHARITY_ADDRESS_2, res);
});

function handleSms(incomingMessage, charity_address, res) {
  console.log(incomingMessage.From + ' got message: "' + incomingMessage.Body + '" from: ' + incomingMessage.From );

  // Check if this phone number has already voted
  twilioClient.messages.list({ from: incomingMessage.From }, function(err, data){
    if (err) {
      console.error(err);
      return;
    }
    var fundingRequests = _.map(data.messages, function(message) {
      if (message.date_sent) {
        var dateSent = new Date(message.date_sent).getTime();
        if (dateSent < serverStartTime) {
          return null;
        }
      }
      if (message.sid==incomingMessage.MessageSid) {
        return null;
      }
      return message.from;
    });
    fundingRequests = _.without(fundingRequests, null);

    if (fundingRequests.length) {
      sendTwilioResponse(res, 'We\'re sorry, but you can only vote once in the Codius demo.');
    } else {
      usd_donated -= usd_to_donate;
      sendUSD(charity_address, usd_to_donate);
      sendTwilioResponse(res, 'Thanks for participating in the Codius demo! $' + usd_to_donate + ' will be donated to your selected charity.');
    }
  });
}

function sendTwilioResponse(res, message) {
  var twiml = new twilio.TwimlResponse();
  twiml.message(message);
  res.set('Content-Type', 'text/xml');
  res.status(200);
  res.send(twiml.toString());
}

remote.connect(function() {
  console.log('remote connected');

  remote.set_secret(process.env.ADDRESS, process.env.SECRET);

  app.listen(app.get('port'), function(){
    console.log('listening');
  });
});