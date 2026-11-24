// The production icon, as GitHub shows the Ankiel Code app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/ankiel-black-web-apple-touch-180.png";

export function AnkielAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
