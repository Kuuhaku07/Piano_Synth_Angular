import { Routes } from '@angular/router';
import { PianoPageComponent } from '@soundboard-ng';

export const routes: Routes = [
  {
    path: '',
    component: PianoPageComponent,
  },
  {
    path: 'piano',
    component: PianoPageComponent,
  },
  {
    path: '**',
    redirectTo: '',
    pathMatch: 'full',
  },
];