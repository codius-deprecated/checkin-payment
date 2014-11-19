var express = require('express');
var bodyParser = require('body-parser');
// var auth = require('./lib/auth');
var _ = require('underscore');
var Remote = require('ripple-lib').Remote;
var Amount = require('ripple-lib').Amount;
var twilio = require('twilio');
var cors = require('cors');

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
} else if (!process.env.PHONE_NUMBER_0) {
  throw new Error('Must supply environment variables PHONE_NUMBER_0');
} else if (!process.env.PHONE_NUMBER_1) {
  throw new Error('Must supply environment variables PHONE_NUMBER_1');
} else if (!process.env.PHONE_NUMBER_2) {
  throw new Error('Must supply environment variables PHONE_NUMBER_2');
} else if (!process.env.USD_TO_DONATE) {
  throw new Error('Must supply environment variables USD_TO_DONATE');
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
app.use(cors());

var twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

var serverStartTime = Date.now();
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
    'issuer':process.env.USD_ISSUER,
    'value':usd_to_buy
  }, xrp_drops_to_spend);

  tx.submit(function(err, result) {
    if (err) {
      console.log(err);
      console.log(tx)
    } else {
      console.log('Successfully designated ' + usd_to_buy + ' USD to donate to charity');
      updateContractUSDBalance();
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
      updateContractUSDBalance();
      switch (recipient) {
        case process.env.CHARITY_ADDRESS_0:
          updateCharityBalance(process.env.CHARITY_ADDRESS_0, 0);
          break;
        case process.env.CHARITY_ADDRESS_1:
          updateCharityBalance(process.env.CHARITY_ADDRESS_1, 1);
          break;
        case process.env.CHARITY_ADDRESS_2:
          updateCharityBalance(process.env.CHARITY_ADDRESS_2, 2);
          break;
      }
    }
  });
}

app.get('/name', function(req, res) {
  res.json(guests.shift());
});

app.get('/tobedonated', function(req, res) {
  res.json(usd_donated);
});

app.get('/charity0', function(req, res) {
  res.json(charity_usd_balances[0].toString());
});

app.get('/charity1', function(req, res) {
  res.json(charity_usd_balances[1].toString());
});

app.get('/charity2', function(req, res) {
  res.json(charity_usd_balances[2].toString());
});

app.get('/phonenumber0', function(req, res) {
  res.json(process.env.PHONE_NUMBER_0);
});

app.get('/phonenumber1', function(req, res) {
  res.json(process.env.PHONE_NUMBER_1);
});

app.get('/phonenumber2', function(req, res) {
  res.json(process.env.PHONE_NUMBER_2);
});

// Envoy webhook POST request for each new visitor sign in.
// https://signwithenvoy.com/account/edit/webhook
app.post('/signin', function(req, res) {
  var signin = req.body;
  console.log(signin);
  var entry = JSON.parse(signin.entry);

  console.log(entry.your_full_name + ' signed in');

  //TODO: Confirm signature is from Envoy using signin.token && signin.timestamp

  if (signin.status==='sign_in') {
    guests.push(entry.your_full_name);
  }

  convertToUSD(process.env.USD_TO_DONATE, parseFloat(process.env.USD_TO_DONATE) * 300000000);

  res.set('Content-Type', 'text/xml');
  res.sendStatus(200);
});

// Receive SMS notifications from Twilio
// https://www.twilio.com/user/account/phone-numbers/incoming
app.post('/sms0', function(req, res) {
  handleSms(req.body, process.env.CHARITY_ADDRESS_0, res);
});

app.post('/sms1', function(req, res) {
  handleSms(req.body, process.env.CHARITY_ADDRESS_1, res);
});

app.post('/sms2', function(req, res) {
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
      sendUSD(charity_address, process.env.USD_TO_DONATE);
      sendTwilioResponse(res, 'Thanks for participating in the Codius demo! $' + process.env.USD_TO_DONATE + ' will be donated to your selected charity.');
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

function getUSDBalance(account, callback) {
  remote.requestAccountLines({'account':account}, function (err, result) {
    if (err) {
      callback(err);
    } else {
      var i;
      for (i=0; i<result.lines.length; i++) {
        if (result.lines[i].account===process.env.USD_ISSUER &&
            result.lines[i].currency==='USD') {
          callback(null, parseFloat(result.lines[i].balance).toFixed(2));
          break;
        }
      }
    }
  });
}

function updateContractUSDBalance() {
  getUSDBalance(process.env.ADDRESS, function(err, balance) {
    if (err) {
      console.log(err);
    } else {
      usd_donated = balance;
    }
  });
}

function updateCharityBalance(account, charity_idx) {
   getUSDBalance(account, function(err, balance) {
    if (err) {
      console.log(err);
    } else {
      charity_usd_balances[charity_idx] = balance
    }
  });
}

remote.connect(function() {
  console.log('remote connected');

  updateContractUSDBalance();
  updateCharityBalance(process.env.CHARITY_ADDRESS_0, 0);
  updateCharityBalance(process.env.CHARITY_ADDRESS_1, 1);
  updateCharityBalance(process.env.CHARITY_ADDRESS_2, 2);

  remote.set_secret(process.env.ADDRESS, process.env.SECRET);

  app.listen(app.get('port'), function(){
    console.log('listening');
  });
});
