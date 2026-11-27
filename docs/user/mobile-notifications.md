# Mobile notifications

The iOS app can alert you when an agent finishes, fails, needs your approval, or is waiting for your input. Tap an alert to open its thread.

Alerts travel through your own [Cloudflare Relay](./remote-access.md#cloudflare-relay): each computer hands the alert to its relay, and the relay delivers it to your phone. Nothing passes through a service run by Ankiel Code.

## Before you start

- The computer must be connected to a Cloudflare Relay. A computer without a relay can't send alerts, even when your phone reaches it on the same network.
- The relay needs an Apple Push Notification (APNs) key. Follow [Push notifications in the relay setup guide](../../relay/SETUP_CLOUDFLARE.md#push-notifications-optional) to add one. An APNs key only reaches apps signed by the same Apple team, so build and sign the iOS app with your own team.

## Turn on alerts

1. On your iPhone or iPad, open **Settings → Notifications**.
2. Turn on **Push notifications** and allow notifications when iOS asks.
3. Choose which alerts you want under **Alerts**:
   - **Finished**: an agent completed its work.
   - **Failed**: an agent's run stopped with an error.
   - **Needs approval**: an agent is waiting for you to approve an action.
   - **Needs input**: an agent asked you a question.

The app signs up with every computer you've paired as soon as it connects to it. Each computer's status appears under **Computers**:

| Status                            | What it means                                                           |
| --------------------------------- | ----------------------------------------------------------------------- |
| On                                | Alerts from this computer reach this phone.                             |
| Relay not set up on this computer | Connect the computer to a Cloudflare Relay.                             |
| Relay offline                     | The computer has a relay but can't reach it right now.                  |
| Relay has no push key             | Add an APNs key to the relay.                                           |
| Not connected                     | Open the app while the computer is online so it can sign up for alerts. |

If you turned notifications off for Ankiel Code in iOS Settings, the page shows a shortcut to turn them back on.

## Good to know

- Alerts stay quiet while the app is open, since the app already shows what changed.
- Snoozed threads don't send alerts.
- Alerts follow your iPhone's language.
- Turning **Push notifications** off stops alerts from each computer as soon as the app reaches it. Removing a computer from the app while it's connected stops its alerts too. To stop alerts from a computer you can't reach, revoke this device in that computer's **Settings → Sharing & access**.
- Android isn't supported yet.
