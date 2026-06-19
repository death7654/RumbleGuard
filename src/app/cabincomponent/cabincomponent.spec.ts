import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Cabincomponent } from './cabincomponent';

describe('Cabincomponent', () => {
  let component: Cabincomponent;
  let fixture: ComponentFixture<Cabincomponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Cabincomponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Cabincomponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
