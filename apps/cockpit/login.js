// The cockpit's sign-in page. Sends the password once; after that the
// session cookie the server sets is used.
(function () {
  "use strict";

  var form = document.getElementById("login-form");
  var input = document.getElementById("password");
  var button = document.getElementById("submit");
  var message = document.getElementById("message");

  // Why the browser was sent here, saved by the page that sent it.
  // Usually there is nothing, and no message is shown.
  //
  // Read from sessionStorage, not from the URL, on purpose: then a link
  // written by someone else can't put text above the password field.
  var NOTICE = "genug-cockpit-notice";

  var NOTICES = {
    // Set below, just before going to the cockpit, and cleared by
    // cockpit.js as soon as it runs. Finding it still here means the
    // browser came back without loading the cockpit, which means the
    // session cookie was refused.
    "cookie-refused": {
      critical: true,
      text: "That password was accepted, but your browser did not keep the session cookie. The cockpit needs https — or http on localhost. A plain http address on your network will not work.",
    },
    "signed-out": {
      critical: false,
      text: "Signed out. Any other browser signed in to this cockpit is signed out too.",
    },
    "signed-out-this-tab": {
      critical: true,
      text: "This browser is signed out. Other browsers may still be signed in: this tab's session had already ended, so it could not end theirs. To sign them all out, sign in and press Log out again.",
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
      // Private mode or blocked storage. Not needed to sign in.
      return null;
    }
  }

  function leaveNotice(value) {
    try {
      sessionStorage.setItem(NOTICE, value);
    } catch {
      // As above: only a message is lost.
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
        // Required by the server, as for every cockpit write: a plain
        // form on another site can't set this header.
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
              // A fixed address, never one from the URL: a sign-in page
              // that redirects wherever a link says can send the owner to
              // a fake page.
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
