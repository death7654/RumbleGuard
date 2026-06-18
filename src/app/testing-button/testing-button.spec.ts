import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TestingButton } from './testing-button';

describe('TestingButton', () => {
  let component: TestingButton;
  let fixture: ComponentFixture<TestingButton>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestingButton]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TestingButton);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
