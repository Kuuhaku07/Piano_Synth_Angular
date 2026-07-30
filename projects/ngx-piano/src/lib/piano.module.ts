import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { PianoPageComponent } from './pages/piano/piano-page.component';
import { PianoSequencerComponent } from './pages/piano/lib-sequencer/piano-sequencer.component';

@NgModule({
  imports: [CommonModule, FormsModule, PianoPageComponent, PianoSequencerComponent],
  exports: [PianoPageComponent, PianoSequencerComponent],
})
export class PianoModule {}