// The cockpit's sign-in page. Posts the password once; everything
// afterwards rides on the session cookie the server sets.
(function () {
  "use strict";

  var form = document.getElementById("login-form");
  var input = document.getElementById("password");
  var button = document.getElementById("submit");
  var message = document.getElementById("message");

  // Why the browser is here, left behind by whoever sent it. Arriving
  // with nothing is the ordinary case — someone opened the cockpit — and
  // gets no message at all.
  //
  // Read through sessionStorage rather than a query string on purpose:
  // this page never reads its own URL, so there is nothing for a link
  // someone else wrote to put on the screen above a password field.
  var NOTICE = "genug-cockpit-notice";

  var NOTICES = {
    // Set just below, before leaving for the cockpit. cockpit.js clears
    // it the moment it runs — so finding it still here means the browser
    // was sent back without ever loading that page, which is what a
    // refused cookie looks like and nothing else does.
    "cookie-refused": {
      critical: true,
      text: "That password was accepted, but your browser did not keep the session cookie. The cockpit needs https — or http on localhost. A plain http address on your network will not work.",
    },
    "signed-out": {
      critical: false,
      text: "Signed out. Any other browser signed in to this cockpit is signed out too.",
    },
    expired: {
      critical: false,
      text: "Your session ran out after 12 hours. Sign in again.",
    },
  };

  function show(text, critical) {
    message.textContent = text;
    message.classList.toggle("is-critical", critical === true);
  }

  function takeNotice() {
    try {
      var value = sessionStorage.getItem(NOTICE);
      sessionStorage.removeItem(NOTICE);
      return value;
    } catch {
      // Private mode, or storage blocked. Nothing here needs it.
      return null;
    }
  }

  function leaveNotice(value) {
    try {
      sessionStorage.setItem(NOTICE, value);
    } catch {
      // See above — this only ever improves a message.
    }
  }

  var arrived = NOTICES[takeNotice()];
  if (arrived) show(arrived.text, arrived.critical);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    button.disabled = true;
    show("", false);

    fetch("session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Required by the server, like every other cockpit write: a
        // header no cross-site form can set.
        "x-genug-cockpit": "1",
      },
      body: JSON.stringify({ password: input.value }),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (response.ok) {
              leaveNotice("cookie-refused");
              // A fixed destination. Never a value from the URL: a
              // sign-in page that forwards wherever it is told is how
              // someone else's page ends up collecting this password.
              window.location.replace("index.html");
              return;
            }
            button.disabled = false;
            input.select();
            show(body.error || "Sign-in failed.", true);
          });
      })
      .catch(function () {
        button.disabled = false;
        show("Could not reach the server. Is it still running?", true);
      });
  });
})();
