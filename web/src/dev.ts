// The page `npm run dev` serves: the library, playing whatever package is in public/.
//
// A packaged build's page is generated and says the same things this does; this one exists so
// the runtime can be worked on against a package without building one every time.
import { play, type Game } from './index';

declare global {
  interface Window { fusion?: Game; fusionError?: string }
}

play({ package: 'game.zip', canvas: 'game' })
  .then((game) => { window.fusion = game; document.title = game.data.manifest.appName; })
  .catch((error: unknown) => {
    console.error(error);
    window.fusionError = error instanceof Error ? error.message : String(error);
  });
